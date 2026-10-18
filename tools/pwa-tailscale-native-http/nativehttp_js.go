//go:build js && wasm

package nativehttp

import (
	"context"
	"crypto/x509"
	"math"
	"syscall/js"
)

type jsHTTPBridge struct {
	registry Registry
	ctx      context.Context
	dial     Dial
	roots    *x509.CertPool
	guard    Guard
}

// BindJS binds one original node generation. Only the owned Go node adapter may
// supply these already-approved dial/trust/authority inputs; JavaScript cannot
// replace them. The paired JS owner must close its pending promises before close.
func BindJS(ctx context.Context, dial Dial, roots *x509.CertPool, guard Guard) (map[string]any, error) {
	if ctx == nil || dial == nil || roots == nil || guard == nil {
		return nil, errInput
	}
	bridge := &jsHTTPBridge{ctx: ctx, dial: dial, roots: roots.Clone(), guard: guard}
	begin := js.FuncOf(bridge.begin)
	current := js.FuncOf(bridge.current)
	cancel := js.FuncOf(bridge.cancel)
	var closeBridge js.Func
	closeBridge = js.FuncOf(func(js.Value, []js.Value) any {
		bridge.registry.Close()
		begin.Release()
		current.Release()
		cancel.Release()
		closeBridge.Release() // Release while executing is supported by syscall/js.
		return nil
	})
	return map[string]any{"begin": begin, "current": current, "cancel": cancel, "close": closeBridge}, nil
}

func jsOperationID(value js.Value) (uint64, bool) {
	if value.Type() != js.TypeNumber {
		return 0, false
	}
	n := value.Float()
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 1 || n > maxOperationID || math.Trunc(n) != n {
		return 0, false
	}
	return uint64(n), true
}

func jsBoundedString(value js.Value, limit int) (string, error) {
	if value.Type() != js.TypeString || js.Global().Get("Object").Invoke(value).Get("length").Int() > limit {
		return "", errInput
	}
	text := value.String()
	if len(text) > limit {
		return "", errInput
	}
	return text, nil
}

func jsRequestHeaders(value js.Value) ([]Header, error) {
	if value.IsUndefined() {
		return nil, nil
	}
	array := js.Global().Get("Array")
	if !array.Call("isArray", value).Bool() {
		return nil, errInput
	}
	count := value.Length()
	if count < 0 || count >= maxHeaders {
		return nil, errInput
	}
	headers := make([]Header, 0, count)
	remaining := maxHeaderBytes
	for index := 0; index < count; index++ {
		pair := value.Index(index)
		if !array.Call("isArray", pair).Bool() || pair.Length() != 2 {
			return nil, errInput
		}
		name, err := jsBoundedString(pair.Index(0), remaining)
		if err != nil {
			return nil, err
		}
		remaining -= len(name) + 4
		text, err := jsBoundedString(pair.Index(1), remaining)
		if err != nil {
			return nil, err
		}
		remaining -= len(text)
		headers = append(headers, Header{name, text})
	}
	return headers, nil
}

func jsRequestBody(value js.Value) ([]byte, error) {
	if value.IsUndefined() {
		return nil, nil
	}
	if !value.InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, errInput
	}
	shared := js.Global().Get("SharedArrayBuffer")
	if !shared.IsUndefined() && value.Get("buffer").InstanceOf(shared) {
		return nil, errInput
	}
	size := value.Get("byteLength").Int()
	if size < 0 || size > maxRequest {
		return nil, errInput
	}
	body := make([]byte, size)
	if js.CopyBytesToGo(body, value) != size {
		return nil, errInput
	}
	return body, nil
}

func jsRequest(value js.Value) (request Request, err error) {
	defer func() {
		if recover() != nil {
			request, err = Request{}, errInput
		}
	}()
	if value.Type() != js.TypeObject || value.IsNull() {
		return Request{}, errInput
	}
	if request.Method, err = jsBoundedString(value.Get("method"), 6); err != nil {
		return Request{}, err
	}
	if request.URL, err = jsBoundedString(value.Get("url"), maxURL); err != nil {
		return Request{}, err
	}
	if request.Headers, err = jsRequestHeaders(value.Get("headers")); err != nil {
		return Request{}, err
	}
	request.Body, err = jsRequestBody(value.Get("body"))
	return request, err
}

func jsErrorCode(err error) string {
	switch err {
	case nil:
		return ""
	case errInput:
		return "input"
	case errOperationID:
		return "id"
	case errCapacity:
		return "capacity"
	case errStopped:
		return "stopped"
	case errResponse:
		return "response"
	default:
		return "network"
	}
}

func (bridge *jsHTTPBridge) begin(_ js.Value, args []js.Value) any {
	if len(args) == 0 {
		return "input"
	}
	id, valid := jsOperationID(args[0])
	if !valid {
		return "id"
	}
	request, err := Request{}, errInput
	if len(args) == 4 && args[2].Type() == js.TypeObject && !args[2].IsNull() && args[3].Type() == js.TypeFunction {
		request, err = jsRequest(args[1])
	}
	if err != nil {
		// Existing validation consumes a new valid ID without cancelling an
		// original live entry on a malformed duplicate request.
		_, rejected := bridge.registry.Reserve(bridge.ctx, id, Request{}, bridge.dial, bridge.roots, bridge.guard)
		return jsErrorCode(rejected)
	}
	op, err := bridge.registry.Reserve(bridge.ctx, id, request, bridge.dial, bridge.roots, bridge.guard)
	if err != nil {
		return jsErrorCode(err)
	}
	go bridge.run(op, args[2], args[3])
	return ""
}

func (bridge *jsHTTPBridge) current(_ js.Value, args []js.Value) any {
	if len(args) != 1 {
		return false
	}
	id, valid := jsOperationID(args[0])
	if !valid {
		return false
	}
	bridge.registry.mu.Lock()
	op := bridge.registry.ops[id]
	publishable := op != nil && op.phase == publishing
	bridge.registry.mu.Unlock()
	return publishable && op.Current()
}

func (bridge *jsHTTPBridge) cancel(_ js.Value, args []js.Value) any {
	if len(args) != 1 {
		return false
	}
	id, valid := jsOperationID(args[0])
	return valid && bridge.registry.Cancel(id)
}

func jsPublish(publish, token js.Value, id uint64, response js.Value, code string) {
	defer func() { _ = recover() }() // A JS exception cannot expose a Go/provider error.
	publish.Invoke(token, float64(id), response, code)
}

func (bridge *jsHTTPBridge) run(op *Operation, token, publish js.Value) {
	stop := context.AfterFunc(op.ctx, func() {
		bridge.registry.mu.Lock()
		withdrawn := op.stopped
		bridge.registry.mu.Unlock()
		if withdrawn || bridge.ctx.Err() != nil || op.ctx.Err() == context.DeadlineExceeded {
			jsPublish(publish, token, op.id, js.Null(), "stopped")
		}
	})
	defer stop()
	if err := op.Run(); err != nil {
		jsPublish(publish, token, op.id, js.Null(), jsErrorCode(err))
		return
	}
	bridge.deliver(op, token, publish)
}

func (bridge *jsHTTPBridge) deliver(op *Operation, token, publish js.Value) {
	defer op.Release() // Including Borrow refusal, byte-copy or publisher exceptions.
	defer func() {
		if recover() != nil {
			jsPublish(publish, token, op.id, js.Null(), "network")
		}
	}()
	response, err := op.Borrow()
	if err != nil {
		jsPublish(publish, token, op.id, js.Null(), jsErrorCode(err))
		return
	}
	body := js.Global().Get("Uint8Array").New(len(response.Body))
	if js.CopyBytesToJS(body, response.Body) != len(response.Body) {
		jsPublish(publish, token, op.id, js.Null(), "network")
		return
	}
	headers := make([]any, 0, len(response.Headers))
	for _, header := range response.Headers {
		headers = append(headers, []any{header.Name, header.Value})
	}
	result := js.ValueOf(map[string]any{"status": response.Status, "statusText": response.Reason,
		"url": response.URL, "headers": headers, "body": body})
	// The JS owner checks exact token + original generation/leases + current(id)
	// after this copy, then synchronously resolves. Go Current alone is not commit.
	publish.Invoke(token, float64(op.id), result, "")
}
