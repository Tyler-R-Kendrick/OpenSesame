package nativehttp

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func peerWire(t *testing.T, handler http.HandlerFunc) (string, Dial) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	port := server.Listener.Addr().(*net.TCPAddr).Port
	target := fmt.Sprintf("100.64.0.1:%d", port)
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != target {
			return nil, errors.New("wrong original target")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}
	return "http://" + target + "/proof", dial
}

func TestPeerGETRealHTTPAndProviderHTTPSBoundary(t *testing.T) {
	var calls atomic.Int32
	url, dial := peerWire(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("Peer request gained credentials")
		}
		payload, _ := io.ReadAll(r.Body)
		if len(payload) != 0 {
			t.Error("Peer request gained body")
		}
		w.Header().Set("Set-Cookie", "secret=hidden")
		io.WriteString(w, "actual peer bytes")
	})
	var registry Registry
	op, err := registry.ReservePeerGET(context.Background(), 1, url, dial, func() bool { return true })
	if err != nil || op.Run() != nil {
		t.Fatal("Actual HTTP peer read failed")
	}
	response, err := op.Borrow()
	if err != nil || response.URL != url || string(response.Body) != "actual peer bytes" {
		t.Fatal("Peer response was changed")
	}
	for _, header := range response.Headers {
		if strings.EqualFold(header.Name, "set-cookie") {
			t.Fatal("Peer cookie escaped")
		}
	}
	op.Release()
	if _, err = registry.Reserve(context.Background(), 2, Request{Method: "GET", URL: url}, dial, x509.NewCertPool(), func() bool { return true }); err == nil {
		t.Fatal("Provider registry accepted plain HTTP")
	}
	if calls.Load() != 1 {
		t.Fatal("Provider boundary dialed or peer operation retried")
	}
}

func TestPeerGETRedirectAndBodyLimitsOverActualHTTP(t *testing.T) {
	for _, mode := range []string{"redirect", "redirect-without-location", "oversized-chunked", "compressed"} {
		t.Run(mode, func(t *testing.T) {
			var redirected atomic.Int32
			url, dial := peerWire(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/proof" {
					redirected.Add(1)
				}
				switch mode {
				case "redirect":
					w.Header().Set("Location", "/other")
					w.WriteHeader(302)
				case "redirect-without-location":
					w.WriteHeader(304)
				case "oversized-chunked":
					w.(http.Flusher).Flush()
					io.WriteString(w, strings.Repeat("x", peerGETResponseBytes+1))
				case "compressed":
					w.Header().Set("Content-Encoding", "gzip")
					io.WriteString(w, "not decoded")
				}
			})
			var registry Registry
			op, err := registry.ReservePeerGET(context.Background(), 1, url, dial, func() bool { return true })
			if err != nil {
				t.Fatal(err)
			}
			if op.Run() == nil {
				t.Fatal("Invalid peer reply accepted")
			}
			if redirected.Load() != 0 {
				t.Fatal("Redirect was followed")
			}
		})
	}
}

func TestPeerGETRejectsMethodHeadersBodyAndAuthorityBeforeDial(t *testing.T) {
	for _, input := range []Request{
		{Method: "POST", URL: "http://100.64.0.1/"},
		{Method: "GET", URL: "http://100.64.0.1/", Headers: []Header{{"Authorization", "secret"}}},
		{Method: "GET", URL: "http://100.64.0.1/", Headers: []Header{{"Cookie", "secret"}}},
		{Method: "GET", URL: "http://100.64.0.1/", Body: []byte("secret")},
		{Method: "GET", URL: "ftp://100.64.0.1/"},
		{Method: "GET", URL: "http://user:secret@100.64.0.1/"},
		{Method: "GET", URL: "http://100.64.0.1/#fragment"},
	} {
		if _, err := preparePeerGET(context.Background(), input); err == nil {
			t.Fatal("Invalid peer input accepted")
		}
	}
}

func TestPeerGETCancellationWaitsForOriginalHeldDial(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan error, 1)
	var live atomic.Bool
	live.Store(true)
	dial := func(context.Context, string, string) (net.Conn, error) {
		close(entered)
		<-release
		return nil, errors.New("held")
	}
	var registry Registry
	op, err := registry.ReservePeerGET(context.Background(), 1, "http://100.64.0.1/proof", dial, live.Load)
	if err != nil {
		t.Fatal(err)
	}
	go func() { finished <- op.Run() }()
	<-entered
	live.Store(false)
	registry.Cancel(1)
	select {
	case <-op.retired:
		t.Fatal("Retired before admitted dial returned")
	default:
	}
	close(release)
	select {
	case err = <-finished:
		if err == nil {
			t.Fatal("Cancelled peer read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("Original peer work did not drain")
	}
	select {
	case <-op.retired:
	default:
		t.Fatal("Physical operation still retained")
	}
	if _, err = registry.ReservePeerGET(context.Background(), 1, "http://100.64.0.1/proof", dial, func() bool { return true }); err == nil {
		t.Fatal("Consumed id revived")
	}
}
