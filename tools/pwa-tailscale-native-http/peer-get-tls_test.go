package nativehttp

import (
	"context"
	"crypto/x509"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPeerGETRealTLSUsesOriginalHostnameAndIndependentTrust(t *testing.T) {
	var calls atomic.Int32
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.TLS == nil || r.TLS.ServerName != "native.test" || r.Method != "GET" || r.URL.Path != "/proof" {
			t.Error("Original TLS name or bounded peer GET changed")
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("Peer GET acquired provider credentials")
		}
		w.Write([]byte("actual TLS peer bytes"))
	})
	var registry Registry
	op, err := registry.ReservePeerGETWithRoots(context.Background(), 1, fixture.url+"/proof", fixture.dial, fixture.roots, func() bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	if err = op.Run(); err != nil {
		t.Fatal(err)
	}
	response, err := op.Borrow()
	if err != nil || response.URL != fixture.url+"/proof" || string(response.Body) != "actual TLS peer bytes" {
		t.Fatal("Original TLS peer reply changed")
	}
	if !op.Release() || calls.Load() != 1 {
		t.Fatal("TLS operation failed to retire or retried")
	}
}

func TestPeerGETTLSRefusesUntrustedHostnameAndRouteChanges(t *testing.T) {
	for _, mode := range []string{"bad-ca", "wrong-hostname", "wrong-peer-destination", "default-public-roots"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			dns := "native.test"
			if mode == "wrong-hostname" {
				dns = "other.test"
			}
			fixture := newTarget(t, dns, time.Now().Add(time.Hour), func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.Write([]byte("must not arrive"))
			})
			url, roots := fixture.url+"/proof", fixture.roots
			if mode == "bad-ca" {
				roots = x509.NewCertPool()
			}
			if mode == "wrong-peer-destination" {
				url = strings.Replace(url, "native.test", "other-peer.test", 1)
			}
			var registry Registry
			var op *Operation
			var err error
			if mode == "default-public-roots" {
				op, err = registry.ReservePeerGET(context.Background(), 1, url, fixture.dial, func() bool { return true })
			} else {
				op, err = registry.ReservePeerGETWithRoots(context.Background(), 1, url, fixture.dial, roots, func() bool { return true })
			}
			if err != nil {
				t.Fatal(err)
			}
			if op.Run() == nil || calls.Load() != 0 {
				t.Fatal("Untrusted, wrong-name or substituted peer reached HTTP")
			}
			if _, err := op.Borrow(); err == nil {
				t.Fatal("Refused TLS reply became publishable")
			}
		})
	}
}

func TestPeerGETTLSCallerAbortWaitsForPhysicalReadDrain(t *testing.T) {
	entered, closed := make(chan struct{}), make(chan struct{})
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("held"))
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(closed)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var registry Registry
	op, err := registry.ReservePeerGETWithRoots(ctx, 1, fixture.url+"/proof", fixture.dial, fixture.roots, func() bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- op.Run() }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Actual TLS peer read never entered")
	}
	cancel()
	select {
	case err = <-finished:
		if err == nil {
			t.Fatal("Aborted original TLS owner published success")
		}
	case <-time.After(time.Second):
		t.Fatal("Actual TLS peer operation failed to drain")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Peer did not observe actual TLS connection closing")
	}
	select {
	case <-op.retired:
	default:
		t.Fatal("TLS operation retained its physical slot")
	}
	if _, err := op.Borrow(); err == nil {
		t.Fatal("Aborted peer response remained publishable")
	}
}
