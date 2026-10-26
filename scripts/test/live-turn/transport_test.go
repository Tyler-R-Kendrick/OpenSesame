package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// Exercise real authenticated allocations and bidirectional relay traffic over
// every transport used by the browser fixture, with ordinary certificate trust.
func TestAuthenticatedRelayTransports(t *testing.T) {
	for _, transport := range []string{"udp", "tcp", "tls"} {
		t.Run(transport, func(t *testing.T) {
			quiet := &logging.DefaultLoggerFactory{Writer: io.Discard, DefaultLogLevel: logging.LogLevelDisabled}
			relayAddress := &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
			}
			config := turn.ServerConfig{
				Realm: realm, AuthHandler: authHandler("fixture-user", "fixture-password", ""),
				LoggerFactory: quiet,
			}
			var address string
			var roots *x509.CertPool
			if transport == "udp" {
				listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = listener.Close() })
				address = listener.LocalAddr().String()
				config.PacketConnConfigs = []turn.PacketConnConfig{{
					PacketConn: listener, RelayAddressGenerator: relayAddress,
				}}
			} else {
				listener, err := net.Listen("tcp4", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = listener.Close() })
				address = listener.Addr().String()
				if transport == "tls" {
					directory := t.TempDir()
					mint(directory, nil)
					certificate, err := tls.LoadX509KeyPair(filepath.Join(directory, "cert.pem"), filepath.Join(directory, "key.pem"))
					if err != nil {
						t.Fatal(err)
					}
					pem, err := os.ReadFile(filepath.Join(directory, "cert.pem"))
					if err != nil {
						t.Fatal(err)
					}
					roots = x509.NewCertPool()
					if !roots.AppendCertsFromPEM(pem) {
						t.Fatal("fixture certificate did not parse")
					}
					listener = tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
				}
				config.ListenerConfigs = []turn.ListenerConfig{{Listener: listener, RelayAddressGenerator: relayAddress}}
			}
			server, err := turn.NewServer(config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			newClient := func(password string) *turn.Client {
				var connection net.PacketConn
				var err error
				if transport == "udp" {
					connection, err = net.ListenPacket("udp4", "127.0.0.1:0")
				} else {
					var stream net.Conn
					dialer := &net.Dialer{Timeout: 3 * time.Second}
					if transport == "tls" {
						stream, err = tls.DialWithDialer(dialer, "tcp4", address, &tls.Config{
							RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12,
						})
					} else {
						stream, err = dialer.Dial("tcp4", address)
					}
					if err == nil {
						connection = turn.NewSTUNConn(stream)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = connection.Close() })
				client, err := turn.NewClient(&turn.ClientConfig{
					TURNServerAddr: address, Conn: connection, Realm: realm,
					Username: "fixture-user", Password: password, LoggerFactory: quiet,
					RTO: 20 * time.Millisecond,
				})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(client.Close)
				if err := client.Listen(); err != nil {
					t.Fatal(err)
				}
				return client
			}
			if allocation, err := newClient("wrong-password").Allocate(); err == nil {
				_ = allocation.Close()
				t.Fatal("incorrect credentials were accepted")
			}
			allocation, err := newClient("fixture-password").Allocate()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = allocation.Close() })
			peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = peer.Close() })
			_ = peer.SetDeadline(time.Now().Add(3 * time.Second))
			_ = allocation.SetDeadline(time.Now().Add(3 * time.Second))
			payload := []byte("authenticated relay round trip")
			if _, err := allocation.WriteTo(payload, peer.LocalAddr()); err != nil {
				t.Fatal(err)
			}
			buffer := make([]byte, 1024)
			n, from, err := peer.ReadFrom(buffer)
			if err != nil || !bytes.Equal(buffer[:n], payload) {
				t.Fatalf("outbound relay failed: %v", err)
			}
			if from.String() != allocation.LocalAddr().String() {
				t.Fatal("peer did not receive the relay allocation's source address")
			}
			if _, err := peer.WriteTo(payload, from); err != nil {
				t.Fatal(err)
			}
			n, _, err = allocation.ReadFrom(buffer)
			if err != nil || !bytes.Equal(buffer[:n], payload) {
				t.Fatalf("inbound relay failed: %v", err)
			}
		})
	}
}
