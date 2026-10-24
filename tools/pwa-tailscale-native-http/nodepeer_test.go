package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/cmd/tsconnect/nativehttp"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/netmap"
)

type peerFixture struct {
	self, peer *tailcfg.Node
	machine    key.MachinePublic
	running    bool
	cached     bool
	tka        bool
	route      func(netip.Addr) (nativePeerRoute, bool)
}

func newPeerFixture() *peerFixture {
	online := true
	node := func(id tailcfg.NodeID, stable tailcfg.StableNodeID, ip string) *tailcfg.Node {
		address := netip.MustParsePrefix(ip)
		return &tailcfg.Node{ID: id, StableID: stable, Key: key.NewNode().Public(),
			Machine: key.NewMachine().Public(), MachineAuthorized: true, Online: &online,
			Addresses: []netip.Prefix{address}, AllowedIPs: []netip.Prefix{address}, KeySignature: []byte{1}}
	}
	self := node(1, "original-self", "100.64.0.2/32")
	return &peerFixture{self: self, peer: node(2, "approved-peer", "100.64.0.1/32"), machine: self.Machine, running: true, tka: true}
}

func (f *peerFixture) current(p *nativePeerAuthority) bool {
	nm := &netmap.NetworkMap{SelfNode: f.self.View(), NodeKey: f.self.Key, MachineKey: f.machine,
		Peers: []tailcfg.NodeView{f.peer.View()}, TKAEnabled: f.tka, Cached: f.cached}
	route := f.route
	if route == nil {
		route = func(ip netip.Addr) (nativePeerRoute, bool) {
			return nativePeerRoute{f.peer.View(), netip.PrefixFrom(ip, ip.BitLen()), false}, true
		}
	}
	return p.current(nm, f.running, route, time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC))
}

func authority(t *testing.T) (*nativePeerAuthority, context.Context) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return newNativePeerAuthority(ctx, "approved-peer", cancel), ctx
}

func TestNativePeerPendingThenOriginalReady(t *testing.T) {
	f := newPeerFixture()
	p, ctx := authority(t)
	if p.current(nil, false, nil, time.Now()) || ctx.Err() != nil {
		t.Fatal("Pending original node must not fabricate readiness or prematurely consume its first authorization")
	}
	if !f.current(p) || !f.current(p) || ctx.Err() != nil {
		t.Fatal("Original authorized peer host route must remain usable")
	}
	// Netmap view objects may change without changing the captured identity.
	f.self, f.peer = f.self.Clone(), f.peer.Clone()
	if !f.current(p) {
		t.Fatal("Equivalent immutable netmap snapshot must preserve the original witness")
	}
}

func TestNativePeerExpiryCancelsWithoutAnotherNotification(t *testing.T) {
	f := newPeerFixture()
	p, ctx := authority(t)
	now := time.Now()
	f.peer.KeyExpiry = now.Add(30 * time.Millisecond)
	nm := &netmap.NetworkMap{SelfNode: f.self.View(), NodeKey: f.self.Key, MachineKey: f.machine,
		Peers: []tailcfg.NodeView{f.peer.View()}, TKAEnabled: true}
	route := func(ip netip.Addr) (nativePeerRoute, bool) {
		return nativePeerRoute{f.peer.View(), netip.PrefixFrom(ip, ip.BitLen()), false}, true
	}
	if !p.current(nm, true, route, now) {
		t.Fatal("Initial expiring peer must be authorized")
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("Original HTTP context must end at key expiry without waiting for a subsequent request/read")
	}
	if p.current(nm, true, route, now) {
		t.Fatal("A stale earlier clock or snapshot cannot revive an expired generation")
	}
}

func TestNativePeerWithdrawalCannotAdoptReplacement(t *testing.T) {
	cases := map[string]func(*peerFixture){
		"node stopped":              func(f *peerFixture) { f.running = false },
		"cached map":                func(f *peerFixture) { f.cached = true },
		"peer stable ID replaced":   func(f *peerFixture) { f.peer.StableID = "replacement" },
		"peer node ID replaced":     func(f *peerFixture) { f.peer.ID++ },
		"peer node key replaced":    func(f *peerFixture) { f.peer.Key = key.NewNode().Public() },
		"peer machine replaced":     func(f *peerFixture) { f.peer.Machine = key.NewMachine().Public() },
		"self node key replaced":    func(f *peerFixture) { f.self.Key = key.NewNode().Public() },
		"self machine replaced":     func(f *peerFixture) { f.machine = key.NewMachine().Public() },
		"self ID replaced":          func(f *peerFixture) { f.self.ID++ },
		"peer unauthorized":         func(f *peerFixture) { f.peer.MachineAuthorized = false },
		"self unauthorized":         func(f *peerFixture) { f.self.MachineAuthorized = false },
		"peer expired":              func(f *peerFixture) { f.peer.Expired = true },
		"self expired":              func(f *peerFixture) { f.self.Expired = true },
		"peer key expiry reached":   func(f *peerFixture) { f.peer.KeyExpiry = time.Unix(1, 0) },
		"self key expiry reached":   func(f *peerFixture) { f.self.KeyExpiry = time.Unix(1, 0) },
		"peer offline":              func(f *peerFixture) { online := false; f.peer.Online = &online },
		"peer online absent":        func(f *peerFixture) { f.peer.Online = nil },
		"peer unsigned":             func(f *peerFixture) { f.peer.UnsignedPeerAPIOnly = true },
		"self unsigned":             func(f *peerFixture) { f.self.UnsignedPeerAPIOnly = true },
		"peer TKA signature lost":   func(f *peerFixture) { f.peer.KeySignature = nil },
		"self TKA signature lost":   func(f *peerFixture) { f.self.KeySignature = nil },
		"TKA policy withdrawn":      func(f *peerFixture) { f.tka = false },
		"peer address changed":      func(f *peerFixture) { f.peer.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.3/32")} },
		"self address changed":      func(f *peerFixture) { f.self.Addresses = []netip.Prefix{netip.MustParsePrefix("100.64.0.4/32")} },
		"peer host route withdrawn": func(f *peerFixture) { f.peer.AllowedIPs = nil },
		"self host route withdrawn": func(f *peerFixture) { f.self.AllowedIPs = nil },
		"peer allowed routes changed": func(f *peerFixture) {
			f.peer.AllowedIPs = append(f.peer.AllowedIPs, netip.MustParsePrefix("0.0.0.0/0"))
		},
		"self allowed routes changed": func(f *peerFixture) {
			f.self.AllowedIPs = append(f.self.AllowedIPs, netip.MustParsePrefix("192.0.2.0/24"))
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newPeerFixture()
			p, ctx := authority(t)
			if !f.current(p) {
				t.Fatal("Initial original witness must be authorized")
			}
			original := *f
			f.self, f.peer = f.self.Clone(), f.peer.Clone()
			change(f)
			if f.current(p) || ctx.Err() != context.Canceled {
				t.Fatal("Withdrawal must cancel the original HTTP context before another request")
			}
			if original.current(p) {
				t.Fatal("Restoring a peer or node must never revive the consumed generation")
			}
		})
	}
}

func TestNativePeerRejectsSelectedRouteSubstitution(t *testing.T) {
	for _, name := range []string{"missing", "self", "default", "subnet", "other-peer", "other-key", "offline-view", "unapproved-view"} {
		t.Run(name, func(t *testing.T) {
			f := newPeerFixture()
			p, ctx := authority(t)
			if !f.current(p) {
				t.Fatal("Initial peer must be ready")
			}
			f.route = func(ip netip.Addr) (nativePeerRoute, bool) {
				peer := f.peer.Clone()
				route := nativePeerRoute{peer.View(), netip.PrefixFrom(ip, ip.BitLen()), false}
				switch name {
				case "missing":
					return route, false
				case "self":
					route.self = true
				case "default":
					route.prefix = netip.MustParsePrefix("0.0.0.0/0")
				case "subnet":
					route.prefix = netip.MustParsePrefix("100.64.0.0/10")
				case "other-peer":
					peer.StableID = "other-peer"
				case "other-key":
					peer.Key = key.NewNode().Public()
				case "offline-view":
					online := false
					peer.Online = &online
				case "unapproved-view":
					peer.MachineAuthorized = false
				}
				return route, true
			}
			if f.current(p) || ctx.Err() != context.Canceled {
				t.Fatal("Actual selected route withdrawal must cancel the original context")
			}
		})
	}
}

func TestNativePeerDirectAddressGrants(t *testing.T) {
	for _, s := range []string{"100.64.0.1/32", "100.64.0.0/10", "fd7a:115c:a1e0::1/128", "fd7a:115c:a1e0::/48"} {
		if !nativePeerPrefix(netip.MustParsePrefix(s)) {
			t.Fatalf("Direct tailnet prefix refused: %s", s)
		}
	}
	for _, s := range []string{"0.0.0.0/0", "100.0.0.0/9", "192.168.1.0/24", "127.0.0.1/32", "169.254.1.1/32", "203.0.113.1/32", "::/0", "fd7a:115c:a1e0::/47", "fd00::/64", "::ffff:100.64.0.1/128", "100.64.0.1/24"} {
		if nativePeerPrefix(netip.MustParsePrefix(s)) {
			t.Fatalf("Noncanonical or non-tailnet prefix admitted: %s", s)
		}
	}
}

func TestNativePeerDoesNotTreatConfiguredCIDRAsLiveRoute(t *testing.T) {
	f := newPeerFixture()
	now := time.Now()
	for _, s := range []string{"100.64.0.3", "::ffff:100.64.0.1", "fd7a:115c:a1e0::1", "192.0.2.1"} {
		ip := netip.MustParseAddr(s)
		route := nativePeerRoute{f.peer.View(), netip.PrefixFrom(ip, ip.BitLen()), false}
		if nativePeerRouteMatches(ip, f.peer.View(), route, true, true, now) {
			t.Fatalf("Configured address space must not invent peer address ownership: %s", s)
		}
	}
}

func TestOriginalExitGuardsRemainByteIdentical(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "nodehttp_js.go")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, path, source, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"routeCurrent":    "047d9d3da8ec9fec6f4276bedcdfcdec902c290b6fe4da8ae2308aba4ef16f0d",
		"exitDestination": "2f31e6eb5decc70b598a75e356d806d74c9e096c181fe34d4921600323629799",
	}
	for _, declaration := range parsed.Decls {
		fn, ok := declaration.(*ast.FuncDecl)
		if !ok || want[fn.Name.Name] == "" {
			continue
		}
		body := source[fset.Position(fn.Body.Pos()).Offset:fset.Position(fn.Body.End()).Offset]
		if got := fmt.Sprintf("%x", sha256.Sum256(body)); got != want[fn.Name.Name] {
			t.Fatalf("Peer mode altered original %s protection: %s", fn.Name.Name, got)
		}
		delete(want, fn.Name.Name)
	}
	if len(want) != 0 {
		t.Fatal("Original exit guards missing")
	}
}

func TestNativePeerTLSRefusesChangedPeerBeforeAnyDial(t *testing.T) {
	for _, mode := range []string{"replacement-peer", "subnet-route"} {
		t.Run(mode, func(t *testing.T) {
			var requests, dials atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				requests.Add(1)
			}))
			t.Cleanup(server.Close)
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			fixture := newPeerFixture()
			peer, ctx := authority(t)
			if !fixture.current(peer) {
				t.Fatal("Original peer must be authorized before TLS reservation")
			}
			dial := func(ctx context.Context, network, address string) (net.Conn, error) {
				dials.Add(1)
				return (&net.Dialer{}).DialContext(ctx, network, address)
			}
			var registry nativehttp.Registry
			op, err := registry.ReservePeerGETWithRoots(ctx, 1, server.URL+"/proof", dial, roots, func() bool { return fixture.current(peer) })
			if err != nil {
				t.Fatal(err)
			}
			if mode == "replacement-peer" {
				fixture.peer = fixture.peer.Clone()
				fixture.peer.StableID = "replacement-peer"
			} else {
				fixture.route = func(netip.Addr) (nativePeerRoute, bool) {
					return nativePeerRoute{fixture.peer.View(), netip.MustParsePrefix("100.64.0.0/10"), false}, true
				}
			}
			if op.Run() == nil || ctx.Err() != context.Canceled || dials.Load() != 0 || requests.Load() != 0 {
				t.Fatal("Changed peer/host route reached TLS or retained its original authority")
			}
			if _, err := op.Borrow(); err == nil {
				t.Fatal("Changed peer produced a publishable TLS response")
			}
		})
	}
}
