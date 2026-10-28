//go:build js && wasm

package main

import (
	"context"
	"net"
	"net/netip"
	"strings"
)

// nativeSSHRoute resolves once through the original peer node, then binds the
// exact route, node identity and advertised key set to this session lifetime.
// No public DNS, exit route, caller-supplied key or unadvertised host is trusted.
func (i *jsIPN) nativeSSHRoute(ctx context.Context, host string) (*nodeHTTP, string, error) {
	p := i.peerGET
	if p == nil || !p.current() || host == "" || strings.TrimSpace(host) != host {
		return nil, "", errNativeAuthority
	}
	address := net.JoinHostPort(strings.ToLower(host), "22")
	ipp, via, err := i.dialer.NativePeerDialPlan(ctx, "tcp", address)
	if err != nil || !via || !nativePeerIP(ipp.Addr()) || ipp.Port() != 22 {
		return nil, "", errNativeAuthority
	}
	selected, found := i.lb.PeerForIP(ipp.Addr())
	if !found || selected.IsSelf || !selected.Node.Valid() || !selected.Node.Hostinfo().Valid() {
		return nil, "", errNativeAuthority
	}
	keys, err := parseNativeSSHHostKeys(selected.Node.Hostinfo().SSH_HostKeys().AsSlice())
	if err != nil {
		return nil, "", errNativeSSHHostKey
	}
	lifetime, cancel := context.WithCancel(p.ctx)
	h := &nodeHTTP{node: i, ctx: lifetime, cancel: cancel,
		targets: map[string][]netip.Prefix{address: {netip.PrefixFrom(ipp.Addr(), ipp.Addr().BitLen())}}}
	h.peer = newNativePeerAuthority(lifetime, selected.Node.StableID(), cancel)
	h.peer.sshKeys = keys
	if !h.current() || !h.destinationAllowed(ipp.Addr()) {
		cancel()
		return nil, "", errNativeAuthority
	}
	p.mu.Lock()
	if !p.current() || len(p.sshRoutes) >= 4 {
		p.mu.Unlock()
		cancel()
		return nil, "", errNativeAuthority
	}
	p.sshRoutes[h] = struct{}{}
	p.mu.Unlock()
	context.AfterFunc(lifetime, func() {
		p.mu.Lock()
		delete(p.sshRoutes, h)
		p.mu.Unlock()
	})
	return h, address, nil
}
