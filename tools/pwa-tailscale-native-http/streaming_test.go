package nativehttp

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func openOwnedStream(t *testing.T, registry *Registry, fixture target) *Operation {
	t.Helper()
	op := reserveOperation(t, registry, 1, fixture)
	head, err := op.OpenStream()
	if err != nil || head.Status != 200 || head.URL != fixture.url || len(head.Body) != 0 {
		t.Fatal("Owned stream did not publish only validated headers.")
	}
	return op
}

func TestStreamHeadersAndSSEEventsArriveWithoutEOF(t *testing.T) {
	messages := make(chan string, 1)
	closed := make(chan struct{})
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == "POST" {
			body, _ := io.ReadAll(io.LimitReader(request.Body, 1025))
			if request.URL.Path != "/messages" || string(body) != `{"method":"initialize"}` {
				writer.WriteHeader(400)
				return
			}
			messages <- "event: message\ndata: {\"result\":\"initialized\"}\n\n"
			writer.WriteHeader(202)
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(writer, "event: endpoint\ndata: /messages\n\n")
		writer.(http.Flusher).Flush()
		defer close(closed)
		for {
			select {
			case message := <-messages:
				io.WriteString(writer, message)
				writer.(http.Flusher).Flush()
			case <-request.Context().Done():
				return
			}
		}
	})
	registry := &Registry{}
	defer registry.Close()
	stream := openOwnedStream(t, registry, fixture)
	first, err := stream.Pull(1)
	if err != nil || first.EOF || !bytes.Contains(first.Body, []byte("event: endpoint")) || len(first.Body) > streamChunkBytes {
		t.Fatal("Initial SSE endpoint was buffered until EOF.")
	}
	if stream.Release() {
		t.Fatal("Headers or a nonterminal chunk released a live stream.")
	}
	input := Request{Method: "POST", URL: fixture.url + "/messages", Headers: []Header{{"Content-Type", "application/json"}}, Body: []byte(`{"method":"initialize"}`)}
	posted, err := registry.Reserve(context.Background(), 2, input, fixture.dial, fixture.roots, func() bool { return true })
	if err != nil || posted.Run() != nil {
		t.Fatal("SSE body blocked the independent message POST.")
	}
	response, err := posted.Borrow()
	if err != nil || response.Status != 202 || !posted.Release() {
		t.Fatal("Message POST was not actually accepted.")
	}
	next, err := stream.Pull(2)
	if err != nil || next.EOF || !bytes.Contains(next.Body, []byte("initialized")) {
		t.Fatal("SSE message did not arrive while GET stayed open.")
	}
	pending(t, closed)
	registry.Cancel(1)
	waitSignal(t, closed)
	waitSignal(t, stream.retired)
}

func TestStreamChunksAreBoundedAndEOFRequiresRelease(t *testing.T) {
	payload := bytes.Repeat([]byte{0, 255, 17}, 30<<10)
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, _ *http.Request) { writer.Write(payload) })
	registry := &Registry{}
	defer registry.Close()
	op := openOwnedStream(t, registry, fixture)
	var actual []byte
	for sequence := uint64(1); ; sequence++ {
		chunk, err := op.Pull(sequence)
		if err != nil || chunk.Sequence != sequence || len(chunk.Body) > streamChunkBytes {
			t.Fatal("Chunk exceeded its ordered single credit.")
		}
		actual = append(actual, chunk.Body...)
		for index := range chunk.Body {
			chunk.Body[index] = 99
		}
		if chunk.EOF {
			break
		}
	}
	if !bytes.Equal(actual, payload) {
		t.Fatal("Stream chunk copies changed the actual binary response.")
	}
	pending(t, op.retired)
	if _, err := op.Borrow(); err != errUsed {
		t.Fatal("A stream became a buffered response publication.")
	}
	for id := uint64(2); id <= 4; id++ {
		reserveOperation(t, registry, id, fixture)
	}
	if _, err := registry.Reserve(context.Background(), 5, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true }); err != errCapacity {
		t.Fatal("Unreleased EOF exceeded four total operation slots.")
	}
	if !op.Release() {
		t.Fatal("Physically drained EOF could not be released.")
	}
	waitSignal(t, op.retired)
	reserveOperation(t, registry, 6, fixture)
}

func TestStreamResponseLimitRemainsFourMiB(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, _ *http.Request) {
		writer.Write(bytes.Repeat([]byte("x"), maxResponse+1))
	})
	registry := &Registry{}
	defer registry.Close()
	op := openOwnedStream(t, registry, fixture)
	total := 0
	for sequence := uint64(1); ; sequence++ {
		chunk, err := op.Pull(sequence)
		if err != nil {
			if err != errResponse || total > maxResponse {
				t.Fatal("Oversized stream did not fail at the original body bound.")
			}
			break
		}
		total += len(chunk.Body)
		if chunk.EOF {
			t.Fatal("Oversized stream reported a successful EOF.")
		}
	}
	waitSignal(t, op.retired)
}

func TestStreamRetainsHTTPSHeaderAndTrustRefusals(t *testing.T) {
	for _, mode := range []string{"redirect", "encoding", "trailer", "headers", "length", "expired"} {
		t.Run(mode, func(t *testing.T) {
			until := time.Now().Add(time.Hour)
			if mode == "expired" {
				until = time.Now().Add(-time.Minute)
			}
			fixture := newTarget(t, "native.test", until, func(writer http.ResponseWriter, _ *http.Request) {
				switch mode {
				case "redirect":
					writer.Header().Set("Location", "https://unapproved.test/")
					writer.WriteHeader(302)
				case "encoding":
					writer.Header().Set("Content-Encoding", "gzip")
				case "trailer":
					writer.Header().Set("Trailer", "X-Late")
				case "headers":
					for index := 0; index < 65; index++ {
						writer.Header().Add("X-Count", strings.Repeat("x", index+1))
					}
				case "length":
					writer.Header().Set("Content-Length", "4194305")
				}
				writer.Write([]byte("not a successful response"))
			})
			registry := &Registry{}
			defer registry.Close()
			op := reserveOperation(t, registry, 1, fixture)
			if _, err := op.OpenStream(); err == nil {
				registry.Cancel(1)
				t.Fatal("Streaming weakened original HTTPS response validation.")
			}
			waitSignal(t, op.retired)
		})
	}
}
