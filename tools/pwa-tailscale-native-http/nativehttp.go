// Package nativehttp provides one bounded HTTPS operation over an explicit dialer.
// It does not select routes, resolve approved targets or activate browser transport.
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
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxRequest     = 1 << 20
	maxResponse    = 4 << 20
	maxHeaders     = 64
	maxHeaderBytes = 32 << 10
	maxURL         = 8 << 10
	maxDuration    = 30 * time.Second
)

type Header struct{ Name, Value string }
type Request struct {
	Method, URL string
	Headers     []Header
	Body        []byte
}
type Response struct {
	Status      int
	Reason, URL string
	Headers     []Header
	Body        []byte
}

// Dial must honor its context and connect only to its independently approved target.
type Dial func(context.Context, string, string) (net.Conn, error)
type Guard func() bool

var (
	errInput    = errors.New("Invalid native HTTPS request.")
	errStopped  = errors.New("Native HTTPS authorization ended.")
	errNetwork  = errors.New("Native HTTPS transport failed.")
	errResponse = errors.New("Invalid native HTTPS response.")
)

func current(ctx context.Context, guard Guard) error {
	if ctx.Err() != nil || !guard() {
		return errStopped
	}
	return nil
}

func controls(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 32 || value[i] == 127 {
			return true
		}
	}
	return false
}

func headerName(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range []byte(value) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			continue
		}
		if !strings.ContainsRune("!#$%&'*+-.^_`|~", rune(c)) {
			return false
		}
	}
	return true
}

func forbidden(name string) bool {
	name = strings.ToLower(name)
	if strings.HasPrefix(name, "proxy-") {
		return true
	}
	switch name {
	case "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "cookie", "cookie2", "accept-encoding":
		return true
	}
	return false
}

func dnsLabel(label string) bool {
	if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, c := range []byte(label) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func authority(target *url.URL) bool {
	host := target.Hostname()
	if host == "" || target.User != nil || target.Opaque != "" || strings.Contains(host, "%") {
		return false
	}
	if strings.HasPrefix(target.Host, "[") && !strings.Contains(host, ":") {
		return false
	}
	if net.ParseIP(host) == nil {
		if len(host) > 253 {
			return false
		}
		for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
			if !dnsLabel(label) {
				return false
			}
		}
	}
	return validPort(target)
}

func validPort(target *url.URL) bool {
	port := target.Port()
	if strings.HasSuffix(target.Host, ":") {
		return false
	}
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}

func headerBudget(headers []Header) bool {
	if len(headers) > maxHeaders {
		return false
	}
	remaining := maxHeaderBytes
	for _, header := range headers {
		if len(header.Name) > remaining || len(header.Value) > remaining-len(header.Name)-4 {
			return false
		}
		if !headerName(header.Name) || controls(header.Value) {
			return false
		}
		remaining -= len(header.Name) + len(header.Value) + 4
	}
	return true
}

func permitted(method, rawURL string) bool {
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "https" || !authority(target) || controls(rawURL) || strings.ContainsAny(rawURL, " #") {
		return false
	}
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE":
		return true
	}
	return false
}

func prepare(ctx context.Context, input Request) (*http.Request, error) {
	if len(input.URL) > maxURL || len(input.Body) > maxRequest || len(input.Headers) >= maxHeaders {
		return nil, errInput
	}
	if !permitted(input.Method, input.URL) {
		return nil, errInput
	}
	headers := append([]Header(nil), input.Headers...)
	headers = append(headers, Header{"Accept-Encoding", "identity"})
	if !headerBudget(headers) {
		return nil, errInput
	}
	for _, header := range headers[:len(headers)-1] {
		if forbidden(header.Name) {
			return nil, errInput
		}
	}
	request, err := http.NewRequestWithContext(ctx, input.Method, input.URL, bytes.NewReader(bytes.Clone(input.Body)))
	if err != nil {
		return nil, errInput
	}
	for _, header := range headers {
		request.Header.Add(header.Name, header.Value)
	}
	return request, nil
}

type boundConn struct {
	net.Conn
	stop  func() bool
	ctx   context.Context
	guard Guard
}

func (conn *boundConn) Close() error {
	conn.stop()
	return conn.Conn.Close()
}

func (conn *boundConn) transfer(buffer []byte, action func([]byte) (int, error)) (int, error) {
	if err := current(conn.ctx, conn.guard); err != nil {
		conn.Close()
		return 0, err
	}
	n, err := action(buffer)
	if stopped := current(conn.ctx, conn.guard); stopped != nil {
		conn.Close()
		return 0, stopped
	}
	return n, err
}

func (conn *boundConn) Read(buffer []byte) (int, error) {
	return conn.transfer(buffer, conn.Conn.Read)
}

func (conn *boundConn) Write(buffer []byte) (int, error) {
	return conn.transfer(buffer, conn.Conn.Write)
}

func guardedDial(ctx context.Context, dial Dial, guard Guard) Dial {
	return func(_ context.Context, network, address string) (net.Conn, error) {
		if err := current(ctx, guard); err != nil {
			return nil, err
		}
		conn, err := dial(ctx, network, address)
		if err != nil || conn == nil {
			if conn != nil {
				conn.Close()
			}
			return nil, errNetwork
		}
		bound := &boundConn{
			Conn: conn, stop: context.AfterFunc(ctx, func() { conn.Close() }),
			ctx: ctx, guard: guard,
		}
		if err := current(ctx, guard); err != nil {
			bound.Close()
			return nil, err
		}
		return bound, nil
	}
}

type guardedReader struct {
	ctx    context.Context
	guard  Guard
	reader io.Reader
}

func (reader guardedReader) Read(buffer []byte) (int, error) {
	if err := current(reader.ctx, reader.guard); err != nil {
		return 0, err
	}
	n, err := reader.reader.Read(buffer)
	if stopped := current(reader.ctx, reader.guard); stopped != nil {
		return 0, stopped
	}
	return n, err
}

func responseHeaders(response *http.Response) ([]Header, error) {
	headers := make([]Header, 0)
	for name, values := range response.Header {
		for _, value := range values {
			if len(headers) >= maxHeaders {
				return nil, errResponse
			}
			headers = append(headers, Header{name, value})
		}
	}
	if !headerBudget(headers) {
		return nil, errResponse
	}
	filtered := headers[:0]
	for _, header := range headers {
		if strings.EqualFold(header.Name, "Set-Cookie") {
			continue
		}
		if strings.EqualFold(header.Name, "Connection") && strings.EqualFold(header.Value, "close") {
			continue
		}
		if forbidden(header.Name) && !strings.EqualFold(header.Name, "Content-Length") {
			return nil, errResponse
		}
		filtered = append(filtered, header)
	}
	return filtered, nil
}

func responseAllowed(response *http.Response) bool {
	if response.StatusCode < 200 || response.StatusCode > 599 || response.ContentLength > maxResponse || response.Uncompressed {
		return false
	}
	encodings := response.Header.Values("Content-Encoding")
	if len(encodings) > 1 || len(encodings) == 1 && !strings.EqualFold(encodings[0], "identity") {
		return false
	}
	if response.StatusCode == 204 && len(response.Header.Values("Content-Length")) != 0 {
		return false
	}
	return len(response.Trailer) == 0 && !controls(response.Status)
}

func readResponse(ctx context.Context, guard Guard, input Request, response *http.Response) (Response, error) {
	headers, err := responseHeaders(response)
	if err != nil || !responseAllowed(response) {
		return Response{}, errResponse
	}
	body, err := io.ReadAll(io.LimitReader(guardedReader{ctx, guard, response.Body}, maxResponse+1))
	if err != nil || len(body) > maxResponse || len(response.Trailer) != 0 {
		return Response{}, errResponse
	}
	if (input.Method == "HEAD" || response.StatusCode == 204 || response.StatusCode == 304) && len(body) != 0 {
		return Response{}, errResponse
	}
	if err := response.Body.Close(); err != nil {
		return Response{}, errNetwork
	}
	if err := current(ctx, guard); err != nil {
		return Response{}, err
	}
	_, reason, _ := strings.Cut(response.Status, " ")
	return Response{response.StatusCode, reason, input.URL, headers, body}, nil
}

// Do snapshots inputs and performs one HTTPS request. The guard and dialer must
// already bind the operation to an approved target and current owner authority.
func Do(ctx context.Context, input Request, dial Dial, roots *x509.CertPool, guard Guard) (Response, error) {
	if ctx == nil || dial == nil || roots == nil || guard == nil {
		return Response{}, errInput
	}
	ctx, cancel := context.WithTimeout(ctx, maxDuration)
	defer cancel()
	if err := current(ctx, guard); err != nil {
		return Response{}, err
	}
	request, err := prepare(ctx, input)
	if err != nil {
		return Response{}, err
	}
	transport := &http.Transport{
		Proxy:       nil,
		DialContext: guardedDial(ctx, dial, guard),
		TLSClientConfig: &tls.Config{
			RootCAs: roots.Clone(), MinVersion: tls.VersionTLS12,
			NextProtos: []string{"http/1.1"},
		},
		TLSNextProto:           make(map[string]func(string, *tls.Conn) http.RoundTripper),
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  10 * time.Second,
		MaxResponseHeaderBytes: maxHeaderBytes,
		DisableCompression:     true,
		DisableKeepAlives:      true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport, Jar: nil,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errResponse
		},
	}
	response, err := client.Do(request)
	if stopped := current(ctx, guard); stopped != nil {
		if response != nil {
			response.Body.Close()
		}
		return Response{}, stopped
	}
	if err != nil {
		return Response{}, errNetwork
	}
	defer response.Body.Close()
	return readResponse(ctx, guard, input, response)
}
