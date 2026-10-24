package nativehttp

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const streamChunkBytes = 32 << 10

// StreamChunk is one caller-owned copy. The next ordered Pull acknowledges the
// preceding copy. A bridge must fence the original owner before publication.
type StreamChunk struct {
	Sequence uint64
	Body     []byte
	EOF      bool
}

type streamResponse struct {
	mu        sync.Mutex
	once      sync.Once
	op        *Operation
	response  *http.Response
	transport *http.Transport
	owner     *drainingDial
	head      Response
	method    string
	next      uint64
	bytes     int
	reading   bool
	stop      func() bool
	done      chan struct{}
	err       error
}

func streamTransport(op *Operation, owner *drainingDial) *http.Transport {
	return &http.Transport{
		Proxy: nil, DialContext: guardedDial(op.ctx, owner.dial, op.Current),
		TLSClientConfig:     &tls.Config{RootCAs: op.roots.Clone(), MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}},
		TLSNextProto:        make(map[string]func(string, *tls.Conn) http.RoundTripper),
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
		MaxResponseHeaderBytes: maxHeaderBytes, DisableCompression: true, DisableKeepAlives: true,
	}
}

// OpenStream returns validated HTTPS headers before EOF. Reserve's original
// thirty-second deadline and four-slot registry own the entire body lifetime.
// Buffered Run/Do are unchanged. Pull is one-shot per monotonically ordered credit.
func (op *Operation) OpenStream() (Response, error) {
	if err := op.start(); err != nil {
		return Response{}, err
	}
	owner, err := newDrainingDial(op.dial)
	if err != nil {
		return Response{}, op.finish(Response{}, err)
	}
	transport := streamTransport(op, owner)
	response, head, err := openStreamResponse(op, transport)
	if err != nil {
		transport.CloseIdleConnections()
		owner.sealAndWait()
		return Response{}, op.finish(Response{}, err)
	}
	stream := &streamResponse{op: op, response: response, transport: transport, owner: owner, head: head, method: op.input.Method, next: 1, done: make(chan struct{})}
	op.registry.mu.Lock()
	op.stream = stream
	op.registry.mu.Unlock()
	// Install under the stream lock: cancellation may run immediately, and finish
	// reads stop under the same lock without invoking external callbacks there.
	stream.mu.Lock()
	stream.stop = context.AfterFunc(op.ctx, func() { stream.finish(errStopped) })
	stream.mu.Unlock()
	if !op.Current() {
		stream.finish(errStopped)
		return Response{}, errStopped
	}
	return Response{head.Status, head.Reason, head.URL, append([]Header(nil), head.Headers...), nil}, nil
}

func openStreamResponse(op *Operation, transport *http.Transport) (*http.Response, Response, error) {
	request, err := prepare(op.ctx, op.input)
	if err != nil {
		return nil, Response{}, err
	}
	client := &http.Client{Transport: transport, Jar: nil, CheckRedirect: func(*http.Request, []*http.Request) error { return errResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, Response{}, errNetwork
	}
	if !op.Current() {
		response.Body.Close()
		return nil, Response{}, errStopped
	}
	headers, err := responseHeaders(response)
	if err != nil || !responseAllowed(response) {
		response.Body.Close()
		return nil, Response{}, errResponse
	}
	_, reason, _ := strings.Cut(response.Status, " ")
	return response, Response{response.StatusCode, reason, op.input.URL, headers, nil}, nil
}

func (stream *streamResponse) finish(failure error) error {
	stream.once.Do(func() {
		stream.mu.Lock()
		stop := stream.stop
		stream.stop = nil
		stream.mu.Unlock()
		if stop != nil {
			stop()
		}
		if failure != nil {
			stream.op.registry.withdraw(stream.op)
		}
		closeErr := stream.response.Body.Close()
		stream.transport.CloseIdleConnections()
		drainErr := stream.owner.sealAndWait()
		if failure == nil && (closeErr != nil || drainErr != nil) {
			failure = errNetwork
		}
		stream.err = stream.op.finish(stream.head, failure)
		close(stream.done)
	})
	<-stream.done
	return stream.err
}

func (stream *streamResponse) credit(sequence uint64) (int, error) {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	select {
	case <-stream.done:
		return 0, errUsed
	default:
	}
	if stream.reading || sequence != stream.next || sequence == 0 {
		return 0, errUsed
	}
	stream.reading = true
	limit := streamChunkBytes
	if remaining := maxResponse - stream.bytes + 1; remaining < limit {
		limit = remaining
	}
	return limit, nil
}

// Pull reads at most one 32KiB chunk for exactly one credit. There is no body
// prefetch goroutine or JS queue. Cancel keeps capacity until real socket drain;
// EOF keeps its already-drained slot until the publication owner calls Release.
func (op *Operation) Pull(sequence uint64) (StreamChunk, error) {
	if op == nil || op.registry == nil {
		return StreamChunk{}, errInput
	}
	op.registry.mu.Lock()
	stream := op.stream
	op.registry.mu.Unlock()
	if stream == nil {
		return StreamChunk{}, errUsed
	}
	if !op.Current() {
		stream.finish(errStopped)
		return StreamChunk{}, errStopped
	}
	limit, err := stream.credit(sequence)
	if err != nil {
		op.registry.withdraw(op)
		stream.finish(errStopped)
		return StreamChunk{}, err
	}
	defer func() {
		stream.mu.Lock()
		stream.reading = false
		stream.mu.Unlock()
	}()
	buffer := make([]byte, limit)
	count, readErr := (guardedReader{op.ctx, op.Current, stream.response.Body}).Read(buffer)
	stream.mu.Lock()
	stream.bytes += count
	stream.next++
	tooLarge := stream.bytes > maxResponse
	stream.mu.Unlock()
	if !op.Current() {
		stream.finish(errStopped)
		return StreamChunk{}, errStopped
	}
	empty := stream.method == "HEAD" || stream.head.Status == 204 || stream.head.Status == 304
	if tooLarge || empty && count != 0 || readErr != nil && !errors.Is(readErr, io.EOF) {
		stream.finish(errResponse)
		return StreamChunk{}, errResponse
	}
	eof := errors.Is(readErr, io.EOF)
	if eof {
		if len(stream.response.Trailer) != 0 {
			stream.finish(errResponse)
			return StreamChunk{}, errResponse
		}
		if err := stream.finish(nil); err != nil {
			return StreamChunk{}, err
		}
	}
	return StreamChunk{sequence, buffer[:count], eof}, nil
}
