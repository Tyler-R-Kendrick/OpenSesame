//go:build js && wasm

package nativehttp

import (
	"context"
	"syscall/js"
)

type jsHTTPStream struct {
	op             *Operation
	token, publish js.Value
	next           uint64
	pulling        bool
	stop           func() bool
}

func (bridge *jsHTTPBridge) dropStream(stream *jsHTTPStream) {
	bridge.registry.mu.Lock()
	var stop func() bool
	if bridge.streams[stream.op.id] == stream {
		delete(bridge.streams, stream.op.id)
		stop, stream.stop = stream.stop, nil
	}
	bridge.registry.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (bridge *jsHTTPBridge) streamCurrent(stream *jsHTTPStream) bool {
	bridge.registry.mu.Lock()
	original := bridge.streams[stream.op.id] == stream
	bridge.registry.mu.Unlock()
	return original && stream.op.Current()
}

func (bridge *jsHTTPBridge) stopStream(stream *jsHTTPStream, code string) {
	bridge.registry.Cancel(stream.op.id)
	bridge.dropStream(stream)
	jsPublish(stream.publish, stream.token, stream.op.id, js.Null(), code)
}

func (bridge *jsHTTPBridge) beginStream(_ js.Value, args []js.Value) any {
	op, err := bridge.reserveJS(args)
	if err != nil {
		return jsErrorCode(err)
	}
	stream := &jsHTTPStream{op: op, token: args[2], publish: args[3], next: 1}
	bridge.registry.mu.Lock()
	if bridge.streams == nil {
		bridge.streams = make(map[uint64]*jsHTTPStream)
	}
	bridge.streams[op.id] = stream
	bridge.registry.mu.Unlock()
	stop := context.AfterFunc(op.ctx, func() {
		// SDK cancellation already withdraws its Promise before invoking cancel.
		// Internal response failure also cancels this context while draining; do
		// not race its real response/network error with a synthetic stopped code.
		bridge.dropStream(stream)
		if bridge.ctx.Err() != nil || op.ctx.Err() == context.DeadlineExceeded {
			jsPublish(stream.publish, stream.token, op.id, js.Null(), "stopped")
		}
	})
	bridge.registry.mu.Lock()
	original := bridge.streams[op.id] == stream
	if original {
		stream.stop = stop
	}
	bridge.registry.mu.Unlock()
	if !original {
		stop()
	}
	go bridge.openStream(stream)
	return ""
}

func (bridge *jsHTTPBridge) publishStream(stream *jsHTTPStream, result js.Value) (accepted bool) {
	defer func() {
		if recover() != nil {
			accepted = false
		}
	}()
	if !bridge.streamCurrent(stream) {
		return false
	}
	ack := stream.publish.Invoke(stream.token, float64(stream.op.id), result, "")
	return ack.Type() == js.TypeBoolean && ack.Bool()
}

func (bridge *jsHTTPBridge) openStream(stream *jsHTTPStream) {
	defer func() {
		if recover() != nil {
			bridge.stopStream(stream, "network")
		}
	}()
	head, err := stream.op.OpenStream()
	if err != nil {
		bridge.stopStream(stream, jsErrorCode(err))
		return
	}
	if !bridge.streamCurrent(stream) {
		bridge.stopStream(stream, "stopped")
		return
	}
	headers := make([]any, 0, len(head.Headers))
	for _, h := range head.Headers {
		headers = append(headers, []any{h.Name, h.Value})
	}
	packet := js.ValueOf(map[string]any{"status": head.Status, "statusText": head.Reason,
		"url": head.URL, "headers": headers})
	if !bridge.publishStream(stream, packet) {
		bridge.stopStream(stream, "stopped")
	}
}

// pull grants one credit to the exact original token. It never accepts a new
// publisher or looks up a replacement node. Concurrent/replayed owned credits
// withdraw that stream before any second read can be admitted.
func (bridge *jsHTTPBridge) pull(_ js.Value, args []js.Value) any {
	if len(args) != 3 {
		return "input"
	}
	id, valid := jsOperationID(args[0])
	sequence, ordered := jsOperationID(args[1])
	if !valid || !ordered {
		return "id"
	}
	bridge.registry.mu.Lock()
	stream := bridge.streams[id]
	if stream == nil || !args[2].Equal(stream.token) {
		bridge.registry.mu.Unlock()
		return "id"
	}
	invalid := stream.pulling || sequence != stream.next
	if !invalid {
		stream.pulling = true
		stream.next++
	}
	bridge.registry.mu.Unlock()
	if invalid {
		bridge.stopStream(stream, "id")
		return "id"
	}
	if !bridge.streamCurrent(stream) {
		bridge.stopStream(stream, "stopped")
		return "stopped"
	}
	go bridge.readStream(stream, sequence)
	return ""
}

func (bridge *jsHTTPBridge) readStream(stream *jsHTTPStream, sequence uint64) {
	defer func() {
		if recover() != nil {
			bridge.stopStream(stream, "network")
		}
	}()
	chunk, err := stream.op.Pull(sequence)
	if err != nil {
		bridge.stopStream(stream, jsErrorCode(err))
		return
	}
	if !bridge.streamCurrent(stream) {
		bridge.stopStream(stream, "stopped")
		return
	}
	body := js.Global().Get("Uint8Array").New(len(chunk.Body))
	if js.CopyBytesToJS(body, chunk.Body) != len(chunk.Body) {
		bridge.stopStream(stream, "network")
		return
	}
	packet := js.ValueOf(map[string]any{"sequence": float64(chunk.Sequence), "body": body, "eof": chunk.EOF})
	if !bridge.publishStream(stream, packet) {
		bridge.stopStream(stream, "stopped")
		return
	}
	if chunk.EOF {
		bridge.dropStream(stream)
		stream.op.Release() // Real EOF/Close/drain already completed inside Pull.
		return
	}
	bridge.registry.mu.Lock()
	if bridge.streams[stream.op.id] == stream {
		stream.pulling = false
	}
	bridge.registry.mu.Unlock()
}
