//go:build js && wasm

package main

import (
	"context"
	"crypto/x509"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall/js"

	"tailscale.com/cmd/tsconnect/nativehttp"
	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
)

type nodePeerGET struct {
	node        *jsIPN
	roots       *x509.CertPool
	ctx         context.Context
	cancel      context.CancelFunc
	closeBridge func()
	mu          sync.Mutex
	routes      map[*nodeHTTP]struct{}
	sshRoutes   map[*nodeHTTP]struct{}
}

// The independent server-trust object uses the exact public/operator base fields.
// Missing means pinned public roots; present malformed data never falls back.
func nativePeerGETRoots(trust js.Value) (roots *x509.CertPool, valid bool) {
	defer func() {
		if recover() != nil {
			roots, valid = nil, false
		}
	}()
	if trust.IsUndefined() {
		var err error
		roots, err = nativehttp.PublicRoots()
		return roots, err == nil
	}
	if trust.Type() != js.TypeObject || trust.IsNull() {
		return nil, false
	}
	mode := trust.Get("trustMode")
	if mode.Type() != js.TypeString || (mode.String() != "public" && mode.String() != "operator") {
		return nil, false
	}
	keys := js.Global().Get("Object").Call("keys", trust)
	for index := 0; index < keys.Length(); index++ {
		field := keys.Index(index).String()
		if field != "trustMode" && (field != "operatorCAPEM" || mode.String() != "operator") {
			return nil, false
		}
	}
	return nativeTrust(trust)
}

func (i *jsIPN) bindNativePeerGET(trust js.Value) map[string]any {
	roots, valid := nativePeerGETRoots(trust)
	if !valid {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &nodePeerGET{node: i, roots: roots.Clone(), ctx: ctx, cancel: cancel, routes: make(map[*nodeHTTP]struct{}), sshRoutes: make(map[*nodeHTTP]struct{})}
	port, closeBridge, err := nativehttp.BindPeerGETJS(ctx, p.route)
	if err != nil {
		cancel()
		return nil
	}
	p.closeBridge = closeBridge
	i.peerGET = p
	return port
}

func (p *nodePeerGET) current() bool {
	if p.ctx.Err() != nil || p.node.lb.State() != ipn.Running {
		return false
	}
	prefs := p.node.lb.Prefs()
	nm := p.node.lb.NetMapWithPeers()
	return prefs.Valid() && prefs.ExitNodeID() == "" && !prefs.ExitNodeAllowLANAccess() && !prefs.RouteAll() && nm != nil && !nm.Cached && nm.GetMachineStatus() == tailcfg.MachineAuthorized
}

func (p *nodePeerGET) route(parent context.Context, raw string) (*nativehttp.PeerGETRoute, error) {
	if !p.current() {
		return nil, errNativeAuthority
	}
	target, err := url.Parse(raw)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.User != nil || target.Hostname() == "" {
		return nil, errNativeAuthority
	}
	port := target.Port()
	if port == "" {
		port = "80"
		if target.Scheme == "https" {
			port = "443"
		}
	}
	address := net.JoinHostPort(strings.ToLower(target.Hostname()), port)
	// NativePeerDialPlan only reads this original node's MagicDNS/ExtraRecords
	// or a literal; it never performs ambient/exit DNS. No network precedes capture.
	ipp, via, err := p.node.dialer.NativePeerDialPlan(parent, "tcp", address)
	if err != nil || !via || !nativePeerIP(ipp.Addr()) {
		return nil, errNativeAuthority
	}
	selected, found := p.node.lb.PeerForIP(ipp.Addr())
	if !found || selected.IsSelf || !selected.Node.Valid() {
		return nil, errNativeAuthority
	}
	ctx, cancel := context.WithCancel(parent)
	h := &nodeHTTP{node: p.node, ctx: ctx, cancel: cancel, targets: map[string][]netip.Prefix{address: {netip.PrefixFrom(ipp.Addr(), ipp.Addr().BitLen())}}}
	h.peer = newNativePeerAuthority(ctx, selected.Node.StableID(), cancel)
	if !h.current() || !h.destinationAllowed(ipp.Addr()) {
		cancel()
		return nil, errNativeAuthority
	}
	p.mu.Lock()
	if !p.current() || len(p.routes) >= 4 {
		p.mu.Unlock()
		cancel()
		return nil, errNativeAuthority
	}
	p.routes[h] = struct{}{}
	p.mu.Unlock()
	context.AfterFunc(ctx, func() { p.mu.Lock(); delete(p.routes, h); p.mu.Unlock() })
	return &nativehttp.PeerGETRoute{Context: ctx, Dial: h.dial, Roots: p.roots.Clone(), Current: h.current, Close: cancel}, nil
}

func (i *jsIPN) observeNativePeerGET() {
	p := i.peerGET
	if p == nil {
		return
	}
	p.mu.Lock()
	routes := make([]*nodeHTTP, 0, len(p.routes))
	for route := range p.routes {
		routes = append(routes, route)
	}
	for route := range p.sshRoutes {
		routes = append(routes, route)
	}
	p.mu.Unlock()
	for _, route := range routes {
		route.current()
	}
}

func (i *jsIPN) closeNativePeerGET() {
	if i.peerGET != nil {
		i.peerGET.cancel()
		i.peerGET.closeBridge()
	}
}
