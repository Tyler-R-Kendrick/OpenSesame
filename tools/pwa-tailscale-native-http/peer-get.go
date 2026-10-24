package nativehttp

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const peerGETResponseBytes = 1_000_000

// Peer reads are a separate HTTP(S) GET-only surface. Provider Do/Reserve remain
// HTTPS-only. No headers, request body, cookies, proxy or redirect are accepted.
func preparePeerGET(ctx context.Context, input Request) (*http.Request, error) {
	if input.Method != "GET" || len(input.Headers) != 0 || len(input.Body) != 0 || len(input.URL) > maxURL {
		return nil, errInput
	}
	target, err := url.Parse(input.URL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || !authority(target) || controls(input.URL) || strings.ContainsAny(input.URL, " #") || target.Fragment != "" {
		return nil, errInput
	}
	request, err := http.NewRequestWithContext(ctx, "GET", input.URL, nil)
	if err != nil {
		return nil, errInput
	}
	request.Header.Set("Accept-Encoding", "identity")
	return request, nil
}

// ReservePeerGET is for the original Go node's independently verified tailnet
// host-route dialer/guard only; neither callback is supplied by JavaScript.
func (registry *Registry) ReservePeerGET(ctx context.Context, id uint64, rawURL string, dial Dial, guard Guard) (*Operation, error) {
	roots, err := PublicRoots()
	if err != nil {
		return nil, err
	}
	return registry.ReservePeerGETWithRoots(ctx, id, rawURL, dial, roots, guard)
}

// Roots are captured by the original Go node, never supplied by a GET caller.
func (registry *Registry) ReservePeerGETWithRoots(ctx context.Context, id uint64, rawURL string, dial Dial, roots *x509.CertPool, guard Guard) (*Operation, error) {
	if roots == nil {
		target, err := url.Parse(rawURL)
		if err != nil || target.Scheme != "http" {
			return nil, errTrust
		}
		roots = x509.NewCertPool()
	}
	return registry.reserve(ctx, id, Request{Method: "GET", URL: rawURL}, dial, roots, guard, true)
}

func doPeerGET(ctx context.Context, input Request, dial Dial, roots *x509.CertPool, guard Guard) (Response, error) {
	if ctx == nil || dial == nil || roots == nil || guard == nil {
		return Response{}, errInput
	}
	ctx, cancel := context.WithTimeout(ctx, maxDuration)
	defer cancel()
	if err := current(ctx, guard); err != nil {
		return Response{}, err
	}
	request, err := preparePeerGET(ctx, input)
	if err != nil {
		return Response{}, err
	}
	transport := &http.Transport{
		Proxy: nil, DialContext: guardedDial(ctx, dial, guard),
		TLSClientConfig: &tls.Config{
			RootCAs: roots.Clone(), MinVersion: tls.VersionTLS12,
			NextProtos: []string{"http/1.1"},
		},
		TLSNextProto: make(map[string]func(string, *tls.Conn) http.RoundTripper),
		TLSHandshakeTimeout: 10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: maxHeaderBytes,
		DisableCompression: true, DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Jar: nil,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errResponse },
	}
	response, err := client.Do(request)
	if stopped := current(ctx, guard); stopped != nil {
		if response != nil {
			response.Body.Close()
		}
		return Response{}, stopped
	}
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return Response{}, errNetwork
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 || response.ContentLength > peerGETResponseBytes || response.Request.URL.String() != input.URL {
		return Response{}, errResponse
	}
	// Bound chunked responses too; retain the original closer and physical drain.
	response.Body = struct {
		io.Reader
		io.Closer
	}{io.LimitReader(response.Body, peerGETResponseBytes+1), response.Body}
	result, err := readResponse(ctx, guard, input, response)
	if err != nil || len(result.Body) > peerGETResponseBytes {
		if err != nil {
			return Response{}, err
		}
		return Response{}, errResponse
	}
	return result, nil
}
