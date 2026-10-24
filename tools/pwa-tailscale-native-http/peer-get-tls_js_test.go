//go:build js && wasm

package nativehttp

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"syscall/js"
	"testing"
	"time"
)

// Real TLS runs over net.Pipe; neither browser fetch nor a provider port exists.
func peerTLSJSFactory(t *testing.T, mode string, calls *atomic.Int32) PeerGETFactory {
	t.Helper()
	dns := "native.test"
	if mode == "wrong-hostname" {
		dns = "other.test"
	}
	cert, ca := certificate(t, dns, time.Now().Add(time.Hour), false)
	roots := x509.NewCertPool()
	if mode != "bad-ca" {
		roots.AddCert(ca)
	}
	return func(ctx context.Context, raw string) (*PeerGETRoute, error) {
		if raw != "https://native.test/proof" || mode == "withdrawn-route" {
			return nil, errStopped
		}
		child, cancel := context.WithCancel(ctx)
		dial := func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != "native.test:443" {
				t.Error("Original TLS peer destination changed")
				return nil, errInput
			}
			client, server := net.Pipe()
			go func() {
				defer server.Close()
				tlsPeer := tls.Server(server, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
				defer tlsPeer.Close()
				request, err := http.ReadRequest(bufio.NewReader(tlsPeer))
				if err != nil {
					return
				}
				request.Body.Close()
				calls.Add(1)
				if tlsPeer.ConnectionState().ServerName != "native.test" || request.Method != "GET" || request.Header.Get("Authorization") != "" {
					t.Error("TLS name or dedicated GET contract changed")
				}
				io.WriteString(tlsPeer, "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\ntls peer")
			}()
			return client, nil
		}
		return &PeerGETRoute{Context: child, Dial: dial, Roots: roots, Current: func() bool { return child.Err() == nil }, Close: cancel}, nil
	}
}

func TestPeerGETGoJSRealTLSIndependentOfProviderConfiguration(t *testing.T) {
	for _, mode := range []string{"valid", "bad-ca", "wrong-hostname", "withdrawn-route"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			port, closePort, err := BindPeerGETJS(context.Background(), peerTLSJSFactory(t, mode, &calls))
			if err != nil {
				t.Fatal(err)
			}
			defer closePort()
			token := js.Global().Get("Object").New()
			type result struct{ body, code string }
			delivered := make(chan result, 1)
			publish := js.FuncOf(func(_ js.Value, args []js.Value) any {
				if len(args) != 4 || !args[0].Equal(token) || args[1].Int() != 1 {
					delivered <- result{code: "bad-publication"}
					return false
				}
				value := result{code: args[3].String()}
				if value.code == "" {
					body := make([]byte, args[2].Get("body").Get("byteLength").Int())
					js.CopyBytesToGo(body, args[2].Get("body"))
					value.body = string(body)
				}
				delivered <- value
				return true
			})
			defer publish.Release()
			request := map[string]any{"method": "GET", "url": "https://native.test/proof", "headers": []any{}, "body": js.Global().Get("Uint8Array").New(0)}
			code := port["begin"].(js.Func).Invoke(1, request, token, publish).String()
			if mode == "withdrawn-route" {
				if code != "stopped" || calls.Load() != 0 {
					t.Fatal("Withdrawn original route reached TLS")
				}
			} else {
				if code != "" {
					t.Fatal(code)
				}
				select {
				case value := <-delivered:
					if mode == "valid" {
						if value.code != "" || value.body != "tls peer" || calls.Load() != 1 {
							t.Fatal("Actual TLS peer bytes did not cross GoJS")
						}
					} else if value.code != "network" || value.body != "" || calls.Load() != 0 {
						t.Fatal("Invalid TLS trust or name crossed GoJS")
					}
				case <-time.After(time.Second):
					t.Fatal("GoJS TLS result did not settle")
				}
			}
			drained := make(chan bool, 1)
			drainToken := js.Global().Get("Object").New()
			receipt := js.FuncOf(func(_ js.Value, args []js.Value) any {
				drained <- len(args) == 4 && args[0].Equal(drainToken) && args[1].Int() == 0 && args[3].String() == ""
				return true
			})
			defer receipt.Release()
			if port["drain"].(js.Func).Invoke(drainToken, receipt).String() != "" {
				t.Fatal("TLS peer drain refused")
			}
			select {
			case valid := <-drained:
				if !valid {
					t.Fatal("TLS peer physical drain not acknowledged")
				}
			case <-time.After(time.Second):
				t.Fatal("TLS peer physical drain did not settle")
			}
		})
	}
}
