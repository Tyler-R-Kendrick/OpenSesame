package nativehttp

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type target struct {
	server *httptest.Server
	url    string
	roots  *x509.CertPool
	ca     *x509.Certificate
	dial   Dial
}

func signer(t *testing.T, legacy bool) crypto.Signer {
	t.Helper()
	if legacy {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func certificate(t *testing.T, dns string, until time.Time, legacy bool) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	rootKey, leafKey := signer(t, legacy), signer(t, legacy)
	ca := &x509.Certificate{
		SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, rootKey.Public(), rootKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(2), DNSNames: []string{dns},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:   time.Now().Add(-time.Hour), NotAfter: until,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage:    x509.KeyUsageDigitalSignature,
	}
	if legacy {
		leaf.KeyUsage |= x509.KeyUsageKeyEncipherment
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, leafKey.Public(), rootKey)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}, parsed
}

func newTarget(t *testing.T, dns string, until time.Time, handler http.HandlerFunc) target {
	t.Helper()
	return configuredTarget(t, dns, until, handler, nil)
}

func configuredTarget(t *testing.T, dns string, until time.Time, handler http.HandlerFunc, configure func(*tls.Config)) target {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	if configure != nil {
		configure(server.TLS)
	}
	cert, ca := certificate(t, dns, until, server.TLS.MinVersion < tls.VersionTLS12)
	server.TLS.Certificates = []tls.Certificate{cert}
	// Expected negative handshakes must not print raw TLS details in test output.
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})
	port := strconv.Itoa(server.Listener.Addr().(*net.TCPAddr).Port)
	address := net.JoinHostPort("native.test", port)
	dial := func(ctx context.Context, network, requested string) (net.Conn, error) {
		if network != "tcp" || requested != address {
			return nil, errors.New("Unapproved owned fixture target.")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	return target{server, "https://" + address, roots, ca, dial}
}

func rawReply(writer http.ResponseWriter, header string, body []byte) {
	conn, buffer, err := writer.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	buffer.WriteString(header + "\r\n")
	buffer.Write(body)
	buffer.Flush()
}

func values(headers []Header, name string) []string {
	var result []string
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			result = append(result, header.Value)
		}
	}
	return result
}

func failed(t *testing.T, response Response, err error) {
	t.Helper()
	if err != errInput && err != errStopped && err != errNetwork && err != errResponse {
		t.Fatal("Failure must be a static core error, without provider details.")
	}
	if response.Status != 0 || response.URL != "" || response.Reason != "" || len(response.Headers) != 0 || len(response.Body) != 0 {
		t.Fatal("Failed operations must not return partial provider data.")
	}
}

func roundTripHandler(t *testing.T, body []byte) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		payload, readErr := io.ReadAll(request.Body)
		if readErr != nil || !bytes.Equal(payload, body) {
			t.Error("Request body bytes changed.")
		}
		if request.RequestURI != "/a%2Fb?form=%C3%A9%00%2B+" || request.Header.Get("Authorization") != "Bearer secret%2B+" {
			t.Error("URL escapes or explicit credentials changed.")
		}
		if request.Header.Get("Origin") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("Proxy-Authorization") != "" || request.Header.Get("Sec-Fetch-Site") != "" {
			t.Error("Ambient browser, cookie or proxy authority was sent.")
		}
		if request.Header.Get("Accept-Encoding") != "identity" || !reflect.DeepEqual(request.Header.Values("X-Repeat"), []string{"one", "two"}) || request.Header.Get("X-UTF8") != "café" {
			t.Error("Explicit request headers changed.")
		}
		payload = body
		if request.Method == "HEAD" {
			payload = nil
		}
		header := fmt.Sprintf("HTTP/1.1 299 Native fixture\r\nContent-Length: %d\r\nContent-Encoding: identity\r\nX-Method: %s\r\nX-Repeat: one\r\nX-Repeat: two\r\nSet-Cookie: server=secret\r\n", len(body), request.Method)
		rawReply(writer, header, payload)
	}
}

func roundTripResult(t *testing.T, request Request, response Response, err error) {
	t.Helper()
	if err != nil || response.Status != 299 || response.Reason != "Native fixture" || response.URL != request.URL {
		t.Fatal("Actual HTTPS response metadata failed.")
	}
	wantBody := request.Body
	if request.Method == "HEAD" {
		wantBody = nil
	}
	if !bytes.Equal(response.Body, wantBody) || !reflect.DeepEqual(values(response.Headers, "X-Method"), []string{request.Method}) {
		t.Fatal("Method, binary or HEAD semantics changed.")
	}
	if !reflect.DeepEqual(values(response.Headers, "X-Repeat"), []string{"one", "two"}) || len(values(response.Headers, "Set-Cookie")) != 0 {
		t.Fatal("Repeated headers or cookie filtering failed.")
	}
}

func TestRoundTrip(t *testing.T) {
	var proxyHits, calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proxyHits.Add(1) }))
	defer proxy.Close()
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("HTTP_PROXY", proxy.URL)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(&url.URL{Scheme: "https", Host: "native.test"}, []*http.Cookie{{Name: "ambient", Value: "secret"}})
	previous := http.DefaultClient
	http.DefaultClient = &http.Client{Jar: jar}
	t.Cleanup(func() { http.DefaultClient = previous })
	wantBody := []byte{0, 255, 195, 169, '%', '+', '\r', '\n'}
	body := bytes.Clone(wantBody)
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), roundTripHandler(t, wantBody))
	wantHeaders := []Header{{"Authorization", "Bearer secret%2B+"}, {"X-Repeat", "one"}, {"X-Repeat", "two"}, {"X-UTF8", "café"}}
	wantRoots := fixture.roots.Subjects()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		calls.Add(1)
		return fixture.dial(ctx, network, address)
	}
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"} {
		request := Request{method, fixture.url + "/a%2Fb?form=%C3%A9%00%2B+", append([]Header(nil), wantHeaders...), body}
		response, err := Do(context.Background(), request, dial, fixture.roots, func() bool { return true })
		roundTripResult(t, request, response, err)
		if !bytes.Equal(body, wantBody) || !reflect.DeepEqual(request.Headers, wantHeaders) || !reflect.DeepEqual(fixture.roots.Subjects(), wantRoots) {
			t.Fatal("The operation mutated caller-owned body, headers or roots.")
		}
	}
	if proxyHits.Load() != 0 || calls.Load() != 6 {
		t.Fatal("A request used an ambient proxy, retry or cross-operation connection.")
	}
}

func TestExactRequestLimit(t *testing.T) {
	body := bytes.Repeat([]byte{0, 255}, maxRequest/2)
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		if err != nil || !bytes.Equal(payload, body) {
			t.Error("Exact request limit changed body bytes.")
		}
		writer.Write(payload)
	})
	response, err := Do(context.Background(), Request{Method: "PUT", URL: fixture.url, Body: body}, fixture.dial, fixture.roots, func() bool { return true })
	if err != nil || !bytes.Equal(response.Body, body) {
		t.Fatal("Exact request limit did not round-trip over owned TLS.")
	}
}

func TestInvalidInputsNeverDial(t *testing.T) {
	var calls atomic.Int32
	dial := func(context.Context, string, string) (net.Conn, error) {
		calls.Add(1)
		return nil, errors.New("secret endpoint and TLS details")
	}
	requests := []Request{
		{Method: "TRACE", URL: "https://native.test/"},
		{Method: "GET", URL: "http://native.test/"},
		{Method: "GET", URL: "https://user:secret@native.test/"},
		{Method: "GET", URL: "https://native.test/#"},
		{Method: "GET", URL: "https://-invalid.test/"},
		{Method: "GET", URL: "https://native.test:65536/"},
		{Method: "GET", URL: "https://native.test:/"},
		{Method: "GET", URL: "https://[127.0.0.1]/"},
		{Method: "GET", URL: "https:///secret"},
		{Method: "GET", URL: "https://native.test/" + strings.Repeat("x", maxURL)},
		{Method: "POST", URL: "https://native.test/", Body: make([]byte, maxRequest+1)},
		{Method: "GET", URL: "https://native.test/", Headers: []Header{{"X-Secret", "secret\x00"}}},
		{Method: "GET", URL: "https://native.test/", Headers: []Header{{":method", "GET"}}},
		{Method: "GET", URL: "https://native.test/", Headers: []Header{{"X-Limit", strings.Repeat("x", maxHeaderBytes)}}},
		{Method: "GET", URL: "https://native.test/", Headers: make([]Header, maxHeaders)},
	}
	for _, name := range []string{"Host", "Content-Length", "Connection", "Transfer-Encoding", "TE", "Trailer", "Upgrade", "Cookie", "Cookie2", "Proxy-Authorization", "Proxy-Anything", "Accept-Encoding"} {
		requests = append(requests, Request{Method: "GET", URL: "https://native.test/", Headers: []Header{{name, "secret"}}})
	}
	for i, request := range requests {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			response, err := Do(context.Background(), request, dial, x509.NewCertPool(), func() bool { return true })
			failed(t, response, err)
		})
	}
	if calls.Load() != 0 {
		t.Fatal("Invalid requests reached a dialer.")
	}
}

func TestResponseLimitsAndFraming(t *testing.T) {
	cases := []struct {
		name, header string
		body         []byte
		ok           bool
	}{
		{"exact-body-limit", "HTTP/1.1 200 OK\r\n", make([]byte, maxResponse), true},
		{"streamed-overflow", "HTTP/1.1 200 OK\r\n", make([]byte, maxResponse+1), false},
		{"declared-overflow", fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\n", maxResponse+1), nil, false},
		{"truncated", "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n", []byte{0, 255}, false},
		{"conflicting-length", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n", nil, false},
		{"encoded", "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n", []byte{0, 255}, false},
		{"control-header", "HTTP/1.1 200 OK\r\nX-Secret: secret\x00\r\n", nil, false},
		{"control-reason", "HTTP/1.1 200 secret\x00\r\n", nil, false},
		{"hop-header", "HTTP/1.1 200 OK\r\nUpgrade: websocket\r\n", nil, false},
		{"proxy-header", "HTTP/1.1 200 OK\r\nProxy-Authenticate: secret\r\n", nil, false},
		{"header-bytes", "HTTP/1.1 200 OK\r\nX-Limit: " + strings.Repeat("x", maxHeaderBytes) + "\r\n", nil, false},
		{"header-pairs", "HTTP/1.1 200 OK\r\n" + strings.Repeat("X-Repeat: value\r\n", maxHeaders+1), nil, false},
		{"exact-header-pairs", "HTTP/1.1 200 OK\r\n" + strings.Repeat("X-Repeat: value\r\n", maxHeaders), nil, true},
		{"no-content", "HTTP/1.1 204 No Content\r\n", nil, true},
		{"illegal-no-content-framing", "HTTP/1.1 204 No Content\r\nContent-Length: 1\r\n", []byte{0}, false},
		{"not-modified", "HTTP/1.1 304 Not Modified\r\nContent-Length: 42\r\n", nil, true},
		{"trailer", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Secret\r\n", []byte("0\r\nX-Secret: secret\r\n\r\n"), false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, _ *http.Request) {
				rawReply(writer, test.header, test.body)
			})
			response, err := Do(context.Background(), Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
			if !test.ok {
				failed(t, response, err)
				return
			}
			if err != nil || !bytes.Equal(response.Body, test.body) {
				t.Fatal("Valid bounded response failed.")
			}
		})
	}
}
