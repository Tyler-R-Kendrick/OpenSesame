//go:build js && wasm

package nativehttp

import (
	"context"
	"crypto/x509"
	"sync"
	"sync/atomic"
	"syscall/js"
)

// A route factory is owned by the original Go node. It snapshots a specific
// live peer before I/O; the per-operation closer ends only that route witness.
type PeerGETRoute struct {
	Context context.Context
	Dial    Dial
	Roots   *x509.CertPool
	Current Guard
	Close   context.CancelFunc
}
type PeerGETFactory func(context.Context, string) (*PeerGETRoute, error)

type peerGETJS struct {
	bridge           jsHTTPBridge
	factory          PeerGETFactory
	cancel           context.CancelFunc
	mu               sync.Mutex
	work             sync.WaitGroup
	closed, draining bool
	callbacks        []js.Func
	failed           atomic.Bool
}

// BindPeerGETJS deliberately exposes only buffered HTTP(S) GET. No caller TLS roots,
// arbitrary method/headers/body, streaming or JavaScript dial/guard is accepted.
func BindPeerGETJS(node context.Context, factory PeerGETFactory) (map[string]any, func(), error) {
	if node == nil || factory == nil {
		return nil, nil, errInput
	}
	ctx, cancel := context.WithCancel(node)
	p := &peerGETJS{bridge: jsHTTPBridge{ctx: ctx}, factory: factory, cancel: cancel}
	begin := js.FuncOf(p.begin)
	current := js.FuncOf(p.bridge.current)
	cancelOperation := js.FuncOf(p.bridge.cancel)
	closePort := js.FuncOf(func(js.Value, []js.Value) any { p.close(); return nil })
	drain := js.FuncOf(p.drain)
	p.callbacks = []js.Func{begin, current, cancelOperation, closePort, drain}
	return map[string]any{"begin": begin, "current": current, "cancel": cancelOperation, "close": closePort, "drain": drain}, p.close, nil
}

func (p *peerGETJS) reject(id uint64, code string) string {
	p.bridge.registry.mu.Lock()
	defer p.bridge.registry.mu.Unlock()
	if id <= p.bridge.registry.high {
		return "id"
	}
	p.bridge.registry.high = id
	return code
}

func (p *peerGETJS) begin(_ js.Value, args []js.Value) any {
	if len(args) != 4 {
		return "input"
	}
	id, valid := jsOperationID(args[0])
	if !valid {
		return "id"
	}
	input, err := jsRequest(args[1])
	if err != nil || args[2].Type() != js.TypeObject || args[2].IsNull() || args[3].Type() != js.TypeFunction {
		return p.reject(id, "input")
	}
	if _, err = preparePeerGET(p.bridge.ctx, input); err != nil {
		return p.reject(id, jsErrorCode(err))
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return p.reject(id, "stopped")
	}
	p.bridge.registry.mu.Lock()
	replay := id <= p.bridge.registry.high
	p.bridge.registry.mu.Unlock()
	if replay {
		return "id"
	}
	route, err := p.factory(p.bridge.ctx, input.URL)
	if err != nil {
		return p.reject(id, jsErrorCode(err))
	}
	if route == nil || route.Context == nil || route.Dial == nil || route.Current == nil || route.Close == nil {
		if route != nil && route.Close != nil {
			route.Close()
		}
		return "input"
	}
	op, err := p.bridge.registry.ReservePeerGETWithRoots(route.Context, id, input.URL, route.Dial, route.Roots, route.Current)
	if err != nil {
		route.Close()
		return jsErrorCode(err)
	}
	stop := context.AfterFunc(op.ctx, route.Close)
	p.work.Add(1) // Admission/Add and drain/Wait share the closed mutex.
	go func() {
		defer p.work.Done()
		defer route.Close()
		defer stop()
		p.bridge.run(op, args[2], args[3])
		if op.drainFailed {
			p.failed.Store(true)
		}
	}()
	return ""
}

func (p *peerGETJS) close() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	p.cancel()
	p.bridge.registry.Close()
}

// drain acknowledges only after original Run/physical dial/read/write/Close and
// publisher callbacks return. JS result withdrawal alone is never the receipt.
func (p *peerGETJS) drain(_ js.Value, args []js.Value) any {
	if len(args) != 2 || args[0].Type() != js.TypeObject || args[0].IsNull() || args[1].Type() != js.TypeFunction {
		return "input"
	}
	p.mu.Lock()
	if p.draining {
		p.mu.Unlock()
		return "stopped"
	}
	p.draining = true
	p.closed = true
	p.mu.Unlock()
	p.close()
	token, publish := args[0], args[1]
	go func() {
		p.work.Wait()
		code := ""
		if p.failed.Load() {
			code = "network"
		}
		jsPublish(publish, token, 0, js.Null(), code)
		for _, callback := range p.callbacks {
			callback.Release()
		}
	}()
	return ""
}
