package nativehttp

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func waitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatal("Owned socket or operation did not reach the required boundary.")
	}
}

func proveLegacyHandshake(t *testing.T, fixture target) {
	t.Helper()
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", fixture.server.Listener.Addr().String(), &tls.Config{
		RootCAs: fixture.roots, ServerName: "native.test",
		MinVersion: tls.VersionTLS11, MaxVersion: tls.VersionTLS11,
		CipherSuites: []uint16{tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA},
	})
	if err != nil {
		t.Fatal("The owned legacy TLS fixture could not complete its control handshake.")
	}
	defer conn.Close()
	if conn.ConnectionState().Version != tls.VersionTLS11 {
		t.Fatal("The control did not negotiate actual TLS 1.1.")
	}
}

func TestTrustFailuresNeverSendHTTP(t *testing.T) {
	cases := []struct {
		name, dns             string
		until                 time.Time
		emptyRoots, legacyTLS bool
	}{
		{"wrong-ca", "native.test", time.Now().Add(time.Hour), true, false},
		{"wrong-san", "other.test", time.Now().Add(time.Hour), false, false},
		{"expired", "native.test", time.Now().Add(-time.Minute), false, false},
		{"obsolete-tls", "native.test", time.Now().Add(time.Hour), false, true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var hits atomic.Int32
			fixture := configuredTarget(t, test.dns, test.until, func(http.ResponseWriter, *http.Request) {
				hits.Add(1)
			}, func(config *tls.Config) {
				if test.legacyTLS {
					config.MinVersion = tls.VersionTLS10
					config.MaxVersion = tls.VersionTLS11
					config.CipherSuites = []uint16{tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA}
				}
			})
			if test.legacyTLS {
				proveLegacyHandshake(t, fixture)
			}
			roots := fixture.roots
			if test.emptyRoots {
				roots = x509.NewCertPool()
			}
			response, err := Do(context.Background(), Request{Method: "GET", URL: fixture.url}, fixture.dial, roots, func() bool { return true })
			failed(t, response, err)
			if hits.Load() != 0 {
				t.Fatal("Unverified TLS sent an HTTP request.")
			}
		})
	}
}

func TestRedirectAndDialFailureDoNotForward(t *testing.T) {
	var first, second atomic.Int32
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/next" {
			second.Add(1)
			return
		}
		first.Add(1)
		writer.Header().Set("Location", "/next")
		writer.WriteHeader(http.StatusFound)
	})
	request := Request{Method: "GET", URL: fixture.url, Headers: []Header{{"Authorization", "Bearer secret"}}}
	response, err := Do(context.Background(), request, fixture.dial, fixture.roots, func() bool { return true })
	failed(t, response, err)
	if first.Load() != 1 || second.Load() != 0 {
		t.Fatal("A redirect forwarded the credential-bearing request.")
	}
	var dials atomic.Int32
	reject := func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("secret endpoint, query, credential and raw TLS details")
	}
	request.URL = fixture.server.URL
	response, err = Do(context.Background(), request, reject, fixture.roots, func() bool { return true })
	failed(t, response, err)
	if first.Load() != 1 || second.Load() != 0 || dials.Load() != 1 {
		t.Fatal("The failed dial retried or fell back to an ambient connection.")
	}
}

func TestMissingAuthorityAndCanceledStartNeverDial(t *testing.T) {
	var dials atomic.Int32
	dial := func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("Unexpected dial.")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	roots := x509.NewCertPool()
	allowed := func() bool { return true }
	request := Request{Method: "GET", URL: "https://127.0.0.1/"}
	cases := []struct {
		ctx   context.Context
		dial  Dial
		roots *x509.CertPool
		guard Guard
	}{
		{nil, dial, roots, allowed},
		{context.Background(), nil, roots, allowed},
		{context.Background(), dial, nil, allowed},
		{context.Background(), dial, roots, nil},
		{ctx, dial, roots, allowed},
		{context.Background(), dial, roots, func() bool { return false }},
	}
	for _, test := range cases {
		response, err := Do(test.ctx, request, test.dial, test.roots, test.guard)
		failed(t, response, err)
	}
	if dials.Load() != 0 {
		t.Fatal("An inactive or incomplete authority reached the network.")
	}
}

func TestEarlierDeadlineClosesBlockedBody(t *testing.T) {
	started, closed := make(chan struct{}), make(chan struct{})
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Length", "2")
		writer.WriteHeader(http.StatusOK)
		writer.(http.Flusher).Flush()
		close(started)
		<-request.Context().Done()
		close(closed)
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response, err := Do(ctx, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
	failed(t, response, err)
	waitSignal(t, started)
	waitSignal(t, closed)
	if ctx.Err() != context.DeadlineExceeded {
		t.Fatal("The caller's earlier deadline did not bound the body read.")
	}
}

func TestEarlierDeadlineClosesBlockedHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted, closed := make(chan struct{}), make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		t.Cleanup(func() { conn.Close() })
		close(accepted)
		io.Copy(io.Discard, conn)
		close(closed)
	}()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", listener.Addr().String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response, err := Do(ctx, Request{Method: "GET", URL: "https://" + listener.Addr().String()}, dial, x509.NewCertPool(), func() bool { return true })
	failed(t, response, err)
	waitSignal(t, accepted)
	waitSignal(t, closed)
	if ctx.Err() != context.DeadlineExceeded {
		t.Fatal("The caller's earlier deadline did not close the TLS socket.")
	}
}

type outcome struct {
	response Response
	err      error
}

func gatedDial(next Dial) (Dial, <-chan struct{}, chan<- struct{}) {
	entered, release := make(chan struct{}), make(chan struct{})
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		close(entered)
		select {
		case <-release:
			return next(ctx, network, address)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return dial, entered, release
}

func TestRequestAndTrustSnapshots(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil || !bytes.Equal(body, []byte{0, 255}) || request.Header.Get("Authorization") != "Bearer original" {
			t.Error("Caller mutation altered an in-flight request.")
		}
		writer.Write([]byte("complete"))
	})
	for _, mutateTrust := range []bool{false, true} {
		t.Run(map[bool]string{false: "request", true: "trust"}[mutateTrust], func(t *testing.T) {
			dial, entered, release := gatedDial(fixture.dial)
			roots := fixture.roots
			if mutateTrust {
				roots = x509.NewCertPool()
			}
			request := Request{Method: "POST", URL: fixture.url, Headers: []Header{{"Authorization", "Bearer original"}}, Body: []byte{0, 255}}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			done := make(chan outcome, 1)
			go func() {
				response, err := Do(ctx, request, dial, roots, func() bool { return true })
				done <- outcome{response, err}
			}()
			waitSignal(t, entered)
			request.Body[0] = 1
			request.Headers[0].Value = "Bearer changed"
			roots.AddCert(fixture.ca)
			close(release)
			result := <-done
			if mutateTrust {
				failed(t, result.response, result.err)
			} else if result.err != nil || string(result.response.Body) != "complete" {
				t.Fatal("The original request snapshot did not complete over owned TLS.")
			}
		})
	}
}

func TestGuardWithdrawalDuringTLSPreventsCredentialRequest(t *testing.T) {
	var allowed, handshake atomic.Bool
	var requests atomic.Int32
	allowed.Store(true)
	fixture := configuredTarget(t, "native.test", time.Now().Add(time.Hour), func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}, func(config *tls.Config) {
		config.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
			handshake.Store(true)
			allowed.Store(false)
			return nil, nil
		}
	})
	request := Request{Method: "POST", URL: fixture.url, Headers: []Header{{"Authorization", "Bearer secret"}}, Body: []byte("private")}
	response, err := Do(context.Background(), request, fixture.dial, fixture.roots, allowed.Load)
	failed(t, response, err)
	if !handshake.Load() || requests.Load() != 0 {
		t.Fatal("Guard withdrawal during real TLS allowed an HTTP credential request.")
	}
}

type withdrawingBody struct {
	io.ReadCloser
	revoked *atomic.Bool
}

func (body withdrawingBody) Close() error {
	err := body.ReadCloser.Close()
	body.revoked.Store(true)
	return err
}

func TestFinalGuardDiscardsFullyReadRealResponse(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		writer.Write([]byte{0, 255})
	})
	transport := &http.Transport{DialContext: fixture.dial, TLSClientConfig: &tls.Config{RootCAs: fixture.roots, MinVersion: tls.VersionTLS12}, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport}).Get(fixture.url)
	if err != nil {
		t.Fatal("Actual owned TLS response was not established.")
	}
	defer response.Body.Close()
	var revoked atomic.Bool
	response.Body = withdrawingBody{response.Body, &revoked}
	result, err := readResponse(context.Background(), func() bool { return !revoked.Load() }, Request{Method: "GET", URL: fixture.url}, response)
	failed(t, result, err)
	if !revoked.Load() {
		t.Fatal("Final authorization withdrawal was not exercised.")
	}
}
