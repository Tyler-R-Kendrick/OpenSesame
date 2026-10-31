package main

import (
	"context"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"

	"tailscale.com/net/tsaddr"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/netmap"
)

// Only the original LocalBackend adapter supplies these selected-route facts.
// They are never accepted from JavaScript configuration or a caller's claims.
type nativePeerRoute struct {
	node   tailcfg.NodeView
	prefix netip.Prefix
	self   bool
}

type nativePeerRouteForIP func(netip.Addr) (nativePeerRoute, bool)

type nativePeerIdentity struct {
	id         tailcfg.NodeID
	stable     tailcfg.StableNodeID
	nodeKey    key.NodePublic
	machineKey key.MachinePublic
	addresses  string
	allowed    string
	signature  string
	expiry     string
}

type nativePeerWitness struct {
	self, peer nativePeerIdentity
	machine    key.MachinePublic
	tka        bool
}

type nativePeerAuthority struct {
	mu        sync.Mutex
	ctx       context.Context
	timer     *time.Timer
	selected  tailcfg.StableNodeID
	cancel    context.CancelFunc
	witness   *nativePeerWitness
	sshKeys   *nativeSSHHostKeys
	withdrawn bool
}

func newNativePeerAuthority(ctx context.Context, selected tailcfg.StableNodeID, cancel context.CancelFunc) *nativePeerAuthority {
	p := &nativePeerAuthority{ctx: ctx, selected: selected, cancel: cancel}
	context.AfterFunc(ctx, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.withdrawn = true
		if p.timer != nil {
			p.timer.Stop()
		}
	})
	return p
}

func (p *nativePeerAuthority) expireAt(self, peer tailcfg.NodeView, now time.Time) {
	expiry := self.KeyExpiry()
	if next := peer.KeyExpiry(); !next.IsZero() && (expiry.IsZero() || next.Before(expiry)) {
		expiry = next
	}
	if !expiry.IsZero() {
		p.timer = time.AfterFunc(expiry.Sub(now), func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.withdrawn = true
			p.cancel()
		})
	}
}

func nativePeerIP(ip netip.Addr) bool {
	return !ip.Is4In6() && tsaddr.IsTailscaleIP(ip)
}

func nativePeerPrefix(prefix netip.Prefix) bool {
	if !prefix.IsValid() || prefix != prefix.Masked() || !nativePeerIP(prefix.Addr()) {
		return false
	}
	limit := tsaddr.CGNATRange()
	if !prefix.Addr().Is4() {
		limit = tsaddr.TailscaleULARange()
	}
	return prefix.Bits() >= limit.Bits()
}

func nativePeerPrefixSet(prefixes []netip.Prefix) string {
	values := make([]string, len(prefixes))
	for i, prefix := range prefixes {
		values[i] = prefix.String()
	}
	slices.Sort(values)
	return strings.Join(values, "\x00")
}

func nativePeerIdentityOf(node tailcfg.NodeView) nativePeerIdentity {
	return nativePeerIdentity{
		id: node.ID(), stable: node.StableID(), nodeKey: node.Key(), machineKey: node.Machine(),
		addresses: nativePeerPrefixSet(node.Addresses().AsSlice()),
		allowed:   nativePeerPrefixSet(node.AllowedIPs().AsSlice()),
		signature: string(node.KeySignature().AsSlice()), expiry: node.KeyExpiry().UTC().Format(time.RFC3339Nano),
	}
}

func nativePeerAuthorized(node tailcfg.NodeView, tka bool, now time.Time) bool {
	if !node.Valid() || node.ID() == 0 || node.StableID() == "" || node.Key().IsZero() ||
		!node.MachineAuthorized() || node.Expired() || node.UnsignedPeerAPIOnly() {
		return false
	}
	expiry := node.KeyExpiry()
	return (expiry.IsZero() || now.Before(expiry)) && (!tka || node.KeySignature().Len() > 0)
}

func nativePeerHostRoutes(node tailcfg.NodeView) bool {
	if node.Addresses().Len() == 0 {
		return false
	}
	for _, prefix := range node.Addresses().All() {
		if !prefix.IsSingleIP() || !nativePeerIP(prefix.Addr()) ||
			!slices.Contains(node.AllowedIPs().AsSlice(), prefix) {
			return false
		}
	}
	return true
}

func nativePeerRouteMatches(ip netip.Addr, peer tailcfg.NodeView, route nativePeerRoute, found, tka bool, now time.Time) bool {
	return found && !route.self && nativePeerAuthorized(route.node, tka, now) && route.node.Online().Get() && nativePeerIP(ip) &&
		route.prefix == netip.PrefixFrom(ip, ip.BitLen()) &&
		slices.Contains(peer.Addresses().AsSlice(), route.prefix) &&
		nativePeerIdentityOf(route.node) == nativePeerIdentityOf(peer)
}

// Once ready, any observed identity/authorization/route withdrawal cancels the
// original HTTP context permanently. Rejoining cannot adopt a replacement peer.
func (p *nativePeerAuthority) current(nm *netmap.NetworkMap, running bool, routeFor nativePeerRouteForIP, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.withdrawn || p.ctx.Err() != nil {
		return false
	}
	valid := running && routeFor != nil && nm != nil && !nm.Cached && nm.GetMachineStatus() == tailcfg.MachineAuthorized
	var peer tailcfg.NodeView
	if valid {
		peer, valid = nm.PeerWithStableID(p.selected)
	}
	if valid {
		self := nm.SelfNode
		valid = nativePeerAuthorized(self, nm.TKAEnabled, now) &&
			nativePeerAuthorized(peer, nm.TKAEnabled, now) && peer.Online().Get() &&
			!nm.MachineKey.IsZero() && !peer.Machine().IsZero() && nm.NodeKey == self.Key() &&
			(self.Machine().IsZero() || self.Machine() == nm.MachineKey) && self.Key() != peer.Key() &&
			self.ID() != peer.ID() && self.StableID() != peer.StableID() &&
			nativePeerHostRoutes(self) && nativePeerHostRoutes(peer)
	}
	if valid && p.sshKeys != nil {
		hostinfo := peer.Hostinfo()
		if !hostinfo.Valid() {
			valid = false
		} else {
			current, err := parseNativeSSHHostKeys(hostinfo.SSH_HostKeys().AsSlice())
			valid = err == nil && p.sshKeys.equal(current)
		}
	}
	if valid {
		for _, prefix := range peer.Addresses().All() {
			selected, found := routeFor(prefix.Addr())
			if slices.Contains(nm.SelfNode.Addresses().AsSlice(), prefix) ||
				!nativePeerRouteMatches(prefix.Addr(), peer, selected, found, nm.TKAEnabled, now) {
				valid = false
				break
			}
		}
	}
	if valid {
		witness := nativePeerWitness{nativePeerIdentityOf(nm.SelfNode), nativePeerIdentityOf(peer), nm.MachineKey, nm.TKAEnabled}
		if p.witness == nil {
			p.witness = &witness
			p.expireAt(nm.SelfNode, peer, now)
		} else {
			valid = *p.witness == witness
		}
	}
	if !valid && p.witness != nil {
		p.withdrawn = true
		if p.timer != nil {
			p.timer.Stop()
		}
		p.cancel()
	}
	return valid
}
