package main

import (
	"net"
	"sync"

	"github.com/pion/turn/v4"
)

// counts is what one transport saw. Nothing here identifies a person: no name,
// no credential, no peer address, no payload.
type counts struct {
	Packets     int64 `json:"packets"`     // UDP datagrams that reached the listener
	Conns       int64 `json:"conns"`       // TCP connections accepted (TLS: before its handshake)
	Hellos      int64 `json:"hellos"`      // TLS ClientHellos received
	Bytes       int64 `json:"bytes"`       // bytes read from clients
	AuthOK      int64 `json:"authOk"`      // TURN requests that authenticated
	AuthFailed  int64 `json:"authFailed"`  // TURN requests that did not
	Allocations int64 `json:"allocations"` // relays created
}

type stats struct {
	mu    sync.Mutex
	ports map[int]string
	seen  map[string]*counts
}

func newStats() *stats {
	s := &stats{ports: map[int]string{}, seen: map[string]*counts{}}
	for _, name := range []string{"udp", "tcp", "tls"} {
		s.seen[name] = &counts{}
	}
	return s
}

func (s *stats) name(port int, transport string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ports[port] = transport
}

func (s *stats) update(transport string, change func(*counts)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.seen[transport]; ok {
		change(c)
	}
}

func (s *stats) snapshot() map[string]counts {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]counts{}
	for name, c := range s.seen {
		out[name] = *c
	}
	return out
}

// transportOf names the listener a request arrived on by its local port, which
// is how a TLS connection is told from a plain TCP one: both are TCP.
func (s *stats) transportOf(local net.Addr) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ports[port(local)]
}

func (s *stats) hello(transport string) {
	s.update(transport, func(c *counts) { c.Hellos++ })
}

func (s *stats) events() turn.EventHandler {
	return turn.EventHandler{
		OnAuth: func(_, dst net.Addr, _, _, _, _ string, verdict bool) {
			s.update(s.transportOf(dst), func(c *counts) {
				if verdict {
					c.AuthOK++
				} else {
					c.AuthFailed++
				}
			})
		},
		OnAllocationCreated: func(_, dst net.Addr, _, _, _ string, _ net.Addr, _ int) {
			s.update(s.transportOf(dst), func(c *counts) { c.Allocations++ })
		},
	}
}

type countedPacketConn struct {
	net.PacketConn
	s    *stats
	name string
}

func (c *countedPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, addr, err := c.PacketConn.ReadFrom(p)
	if n > 0 {
		c.s.update(c.name, func(k *counts) { k.Packets++; k.Bytes += int64(n) })
	}
	return n, addr, err
}

func (s *stats) countPackets(name string, conn net.PacketConn) net.PacketConn {
	return &countedPacketConn{PacketConn: conn, s: s, name: name}
}

type countedListener struct {
	net.Listener
	s    *stats
	name string
}

type countedConn struct {
	net.Conn
	s    *stats
	name string
}

func (c *countedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.s.update(c.name, func(k *counts) { k.Bytes += int64(n) })
	}
	return n, err
}

func (l *countedListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	l.s.update(l.name, func(k *counts) { k.Conns++ })
	return &countedConn{Conn: conn, s: l.s, name: l.name}, nil
}

func (s *stats) countAccepts(name string, l net.Listener) net.Listener {
	return &countedListener{Listener: l, s: s, name: name}
}
