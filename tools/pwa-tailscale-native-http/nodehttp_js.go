//go:build js && wasm

package main

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall/js"
	"time"

	"tailscale.com/cmd/tsconnect/nativehttp"
	"tailscale.com/ipn"
	"tailscale.com/net/tsaddr"
	"tailscale.com/tailcfg"
)

var errNativeAuthority = errors.New("Native HTTPS authority is not current.")

type nodeHTTP struct {
	node    *jsIPN
	ctx     context.Context
	cancel  context.CancelFunc
	peer    *nativePeerAuthority
	exit    tailcfg.StableNodeID
	targets map[string][]netip.Prefix
	ready   atomic.Bool
}

// Configuration is bounded, explicit operator trust plus exact HTTPS authorities
// and resolved-IP grants. It is captured once, never a JS dialer or mutable policy.
func nativeText(value js.Value, limit int) (string, bool) {
	if value.Type() != js.TypeString || js.Global().Get("Object").Invoke(value).Get("length").Int() > limit {
		return "", false
	}
	text := value.String()
	return text, len(text) <= limit
}

func nativeOperatorRoots(value js.Value) (*x509.CertPool, bool) {
	text, ok := nativeText(value, 64<<10)
	if !ok || text == "" {
		return nil, false
	}
	pool := x509.NewCertPool()
	count := 0
	for rest := []byte(text); len(strings.TrimSpace(string(rest))) != 0; {
		if !strings.HasPrefix(strings.TrimSpace(string(rest)), "-----BEGIN CERTIFICATE-----") {
			return nil, false
		}
		block, next := pem.Decode(rest)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return nil, false
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !cert.IsCA || !cert.BasicConstraintsValid || cert.KeyUsage&x509.KeyUsageCertSign == 0 {
			return nil, false
		}
		count++
		if count > 8 {
			return nil, false
		}
		pool.AddCert(cert)
		rest = next
	}
	return pool, count > 0
}

// Public and operator trust are explicit disjoint choices. Never silently add
// operator CAs to the public pool, or install fallback roots process-wide.
func nativeTrust(value js.Value) (*x509.CertPool, bool) {
	mode := value.Get("trustMode")
	if mode.IsUndefined() || mode.Type() == js.TypeString && mode.String() == "operator" {
		return nativeOperatorRoots(value.Get("operatorCAPEM"))
	}
	if mode.Type() != js.TypeString || mode.String() != "public" || !value.Get("operatorCAPEM").IsUndefined() {
		return nil, false
	}
	roots, err := nativehttp.PublicRoots()
	return roots, err == nil
}

func nativeAuthority(value js.Value) (string, bool) {
	text, ok := nativeText(value, 2048)
	if !ok {
		return "", false
	}
	u, err := url.Parse(text)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	if u.Opaque != "" || u.Path != "" && u.Path != "/" || strings.Contains(u.Hostname(), "%") {
		return "", false
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	if ipp, err := netip.ParseAddrPort(net.JoinHostPort("192.0.2.1", port)); err != nil || ipp.Port() == 0 {
		return "", false
	}
	return net.JoinHostPort(strings.ToLower(u.Hostname()), port), true
}

func nativePrefixes(value js.Value) ([]netip.Prefix, bool) {
	if !js.Global().Get("Array").Call("isArray", value).Bool() || value.Length() < 1 || value.Length() > 16 {
		return nil, false
	}
	prefixes := make([]netip.Prefix, 0, value.Length())
	for index := 0; index < value.Length(); index++ {
		text, ok := nativeText(value.Index(index), 64)
		prefix, err := netip.ParsePrefix(text)
		if !ok || err != nil || prefix != prefix.Masked() || prefix.Addr().Is4In6() {
			return nil, false
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, true
}

func nativeTargets(value js.Value) (map[string][]netip.Prefix, bool) {
	if !js.Global().Get("Array").Call("isArray", value).Bool() || value.Length() < 1 || value.Length() > 16 {
		return nil, false
	}
	targets := make(map[string][]netip.Prefix, value.Length())
	for index := 0; index < value.Length(); index++ {
		item := value.Index(index)
		if item.Type() != js.TypeObject || item.IsNull() {
			return nil, false
		}
		authority, ok := nativeAuthority(item.Get("origin"))
		prefixes, valid := nativePrefixes(item.Get("prefixes"))
		if !ok || !valid || targets[authority] != nil {
			return nil, false
		}
		targets[authority] = prefixes
	}
	return targets, true
}

func (i *jsIPN) bindNativeHTTP(value js.Value) (port map[string]any) {
	defer func() {
		if recover() != nil {
			if i.native != nil {
				i.native.cancel()
			}
			port = nil
		}
	}()
	if value.Type() != js.TypeObject || value.IsNull() {
		return nil
	}
	exit, peer, ok := nativeHTTPRoute(value)
	if !ok {
		return nil
	}
	roots, trusted := nativeTrust(value)
	targets, configured := nativeTargets(value.Get("targets"))
	if !trusted || !configured || peer != "" && !nativePeerTargets(targets) {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &nodeHTTP{node: i, ctx: ctx, cancel: cancel, exit: tailcfg.StableNodeID(exit), targets: targets}
	if peer != "" {
		h.peer = newNativePeerAuthority(ctx, peer, cancel)
	}
	port, err := nativehttp.BindJS(ctx, h.dial, roots, h.current)
	if err != nil {
		cancel()
		return nil
	}
	closeBridge := port["close"].(js.Func)
	var closeNode js.Func
	closeNode = js.FuncOf(func(js.Value, []js.Value) any {
		defer closeNode.Release()
		cancel()
		closeBridge.Invoke()
		return nil
	})
	port["close"] = closeNode
	i.native = h
	return port
}

func (i *jsIPN) nativeExitID() tailcfg.StableNodeID {
	if i.native == nil {
		return ""
	}
	return i.native.exit
}

// observe runs on the original node's notification stream. A previously ready
// generation is permanently withdrawn; a later successor cannot revive requests.
func (i *jsIPN) observeNativeHTTP() {
	if i.native != nil {
		i.native.current()
	}
}

func (h *nodeHTTP) routeCurrent() bool {
	if h.node.lb.State() != ipn.Running {
		return false
	}
	prefs := h.node.lb.Prefs()
	if !prefs.Valid() || prefs.ExitNodeID() != h.exit || prefs.ExitNodeAllowLANAccess() {
		return false
	}
	nm := h.node.lb.NetMapWithPeers()
	if nm == nil || nm.GetMachineStatus() != tailcfg.MachineAuthorized {
		return false
	}
	if nm.TKAEnabled && nm.SelfNode.KeySignature().Len() == 0 {
		return false
	}
	peer, found := nm.PeerWithStableID(h.exit)
	return found && peer.Online().Get() && tsaddr.ContainsExitRoutes(peer.AllowedIPs()) && h.node.dialer.NativeExitDNSReady()
}

func (h *nodeHTTP) current() bool {
	if h.ctx.Err() != nil {
		return false
	}
	if h.peer != nil {
		return h.peerCurrent()
	}
	if h.routeCurrent() {
		h.ready.Store(true)
		return true
	}
	if h.ready.Load() {
		h.cancel()
	}
	return false
}

// No peer/subnet/self address may silently take precedence over the selected
// exit. Literal dial after UserDialPlan prevents a second hostname resolution.
func (h *nodeHTTP) exitDestination(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || ip == netip.MustParseAddr("168.63.129.16") {
		return false
	}
	nm := h.node.lb.NetMapWithPeers()
	if nm == nil {
		return false
	}
	for _, prefix := range nm.GetAddresses().All() {
		if prefix.Contains(ip) {
			return false
		}
	}
	for _, peer := range nm.Peers {
		if peer.StableID() == h.exit {
			continue
		}
		for _, prefix := range peer.AllowedIPs().All() {
			if prefix.Contains(ip) {
				return false
			}
		}
	}
	return true
}

func nativeIPGranted(ip netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

func (h *nodeHTTP) dial(ctx context.Context, network, address string) (net.Conn, error) {
	if ctx.Err() != nil || network != "tcp" || !h.current() {
		return nil, errNativeAuthority
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errNativeAuthority
	}
	prefixes := h.targets[net.JoinHostPort(strings.ToLower(host), port)]
	if len(prefixes) == 0 {
		return nil, errNativeAuthority
	}
	plan := h.node.dialer.UserDialPlan
	if h.peer != nil {
		plan = h.node.dialer.NativePeerDialPlan
	}
	ipp, viaTailnet, err := plan(ctx, network, address)
	if err != nil || !viaTailnet || !nativeIPGranted(ipp.Addr(), prefixes) || !h.destinationAllowed(ipp.Addr()) || !h.current() {
		return nil, errNativeAuthority
	}
	conn, err := h.node.dialer.UserDial(ctx, network, ipp.String())
	if err != nil {
		return nil, errNativeAuthority
	}
	if ctx.Err() != nil || !h.current() || !h.destinationAllowed(ipp.Addr()) {
		conn.Close()
		return nil, errNativeAuthority
	}
	return conn, nil
}

func nativeHTTPRoute(value js.Value) (exit, peer tailcfg.StableNodeID, ok bool) {
	field := "exitNodeID"
	mode := value.Get("routeMode")
	if !mode.IsUndefined() {
		if mode.Type() != js.TypeString || mode.String() != "peer" || !value.Get("exitNodeID").IsUndefined() {
			return "", "", false
		}
		field = "peerID"
	} else if !value.Get("peerID").IsUndefined() {
		return "", "", false
	}
	id, valid := nativeText(value.Get(field), 256)
	if !valid || id == "" || strings.TrimSpace(id) != id {
		return "", "", false
	}
	if field == "peerID" {
		if strings.IndexFunc(id, func(r rune) bool { return r <= 32 || r == 127 }) >= 0 {
			return "", "", false
		}
		return "", tailcfg.StableNodeID(id), true
	}
	return tailcfg.StableNodeID(id), "", true
}

func nativePeerTargets(targets map[string][]netip.Prefix) bool {
	for _, prefixes := range targets {
		for _, prefix := range prefixes {
			if !nativePeerPrefix(prefix) {
				return false
			}
		}
	}
	return true
}

func (h *nodeHTTP) peerRoute(ip netip.Addr) (nativePeerRoute, bool) {
	selected, found := h.node.lb.PeerForIP(ip)
	return nativePeerRoute{selected.Node, selected.Route, selected.IsSelf}, found
}

func (h *nodeHTTP) peerCurrent() bool {
	prefs := h.node.lb.Prefs()
	running := h.node.lb.State() == ipn.Running && prefs.Valid() &&
		prefs.ExitNodeID() == "" && !prefs.ExitNodeAllowLANAccess() && !prefs.RouteAll()
	return h.peer.current(h.node.lb.NetMapWithPeers(), running, h.peerRoute, time.Now())
}

func (h *nodeHTTP) destinationAllowed(ip netip.Addr) bool {
	if h.peer == nil {
		return h.exitDestination(ip)
	}
	if !nativePeerIP(ip) || !h.peerCurrent() {
		return false
	}
	nm := h.node.lb.NetMapWithPeers()
	if nm == nil {
		return false
	}
	peer, found := nm.PeerWithStableID(h.peer.selected)
	if !found {
		return false
	}
	selected, valid := h.peerRoute(ip)
	return nativePeerRouteMatches(ip, peer, selected, valid, nm.TKAEnabled, time.Now())
}
