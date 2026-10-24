package nativehttp

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"sync"
	"time"
)

const maxOperationID = 1<<53 - 1
const operationCapacity = 4

type operationPhase uint8

const (
	reserved operationPhase = iota
	running
	ready
	publishing
)

var (
	errOperationID = errors.New("Invalid or consumed native HTTPS operation ID.")
	errCapacity    = errors.New("Native HTTPS operation capacity reached.")
	errUsed        = errors.New("Native HTTPS operation already used.")
)

// Registry belongs to one original node generation. Close revokes only these
// operations; it never closes the node or its ordinary control/peering traffic.
// Its zero value is usable. Callers must issue monotonically increasing safe IDs.
type Registry struct {
	mu     sync.Mutex
	high   uint64
	closed bool
	ops    map[uint64]*Operation
}

// Operation is an original entry, never looked up in a replacement registry.
// All mutable fields are protected by registry.mu. Context and guard are immutable.
type Operation struct {
	registry    *Registry
	id          uint64
	ctx         context.Context
	guard       Guard
	input       Request
	dial        Dial
	roots       *x509.CertPool
	cancel      context.CancelFunc
	stop        func() bool
	phase       operationPhase
	stopped     bool
	response    Response
	stream      *streamResponse
	retired     chan struct{}
	peerGET     bool
	drainFailed bool
}

type operationCleanup struct {
	stop   func() bool
	cancel context.CancelFunc
}

func (cleanup operationCleanup) run() {
	if cleanup.stop != nil {
		cleanup.stop()
	}
	if cleanup.cancel != nil {
		cleanup.cancel()
	}
}

func validOperationID(id uint64) bool { return id > 0 && id <= maxOperationID }

func (registry *Registry) liveLocked(op *Operation) bool {
	return registry.ops[op.id] == op && !registry.closed && !op.stopped && op.ctx.Err() == nil
}

func (registry *Registry) retireLocked(op *Operation) operationCleanup {
	if registry.ops[op.id] != op {
		return operationCleanup{}
	}
	delete(registry.ops, op.id)
	close(op.retired)
	cleanup := operationCleanup{op.stop, op.cancel}
	op.stop, op.cancel = nil, nil
	op.input, op.response = Request{}, Response{}
	op.stream = nil
	return cleanup
}

func (registry *Registry) stopLocked(op *Operation) operationCleanup {
	op.stopped = true
	cleanup := operationCleanup{cancel: op.cancel}
	op.cancel = nil
	if op.phase == reserved || op.phase == ready {
		cleanup.stop = registry.retireLocked(op).stop
	}
	return cleanup
}

func (registry *Registry) withdraw(op *Operation) bool {
	registry.mu.Lock()
	if registry.ops[op.id] != op || op.stopped {
		registry.mu.Unlock()
		return false
	}
	cleanup := registry.stopLocked(op)
	registry.mu.Unlock()
	cleanup.run()
	return true
}

func (registry *Registry) reserveLocked(ctx context.Context, id uint64, input Request, dial Dial, roots *x509.CertPool, guard Guard, allowed bool, deadline time.Time, peerGET bool) (*Operation, error) {
	if id <= registry.high {
		return nil, errOperationID
	}
	registry.high = id // Rejected valid attempts are consumed, without tombstones.
	if registry.closed {
		return nil, errStopped
	}
	if ctx == nil || dial == nil || roots == nil || guard == nil {
		return nil, errInput
	}
	if len(registry.ops) >= operationCapacity {
		return nil, errCapacity
	}
	if !allowed || ctx.Err() != nil {
		return nil, errStopped
	}
	validate := prepare
	if peerGET {
		validate = preparePeerGET
	}
	if _, err := validate(ctx, input); err != nil {
		return nil, err
	}
	child, cancel := context.WithDeadline(ctx, deadline)
	op := &Operation{registry: registry, id: id, ctx: child, cancel: cancel,
		guard: guard, dial: dial, roots: roots.Clone(), retired: make(chan struct{}), peerGET: peerGET,
		input: Request{input.Method, input.URL, append([]Header(nil), input.Headers...), bytes.Clone(input.Body)}}
	if registry.ops == nil {
		registry.ops = make(map[uint64]*Operation)
	}
	registry.ops[id] = op
	op.stop = context.AfterFunc(child, func() { registry.withdraw(op) })
	return op, nil
}

// Reserve performs bounded validation/snapshots and claims capacity before any
// goroutine or I/O. Caller slices and trust-constraint closures must not mutate
// concurrently with Reserve; the bridge must own its input copies first.
func (registry *Registry) Reserve(ctx context.Context, id uint64, input Request, dial Dial, roots *x509.CertPool, guard Guard) (*Operation, error) {
	return registry.reserve(ctx, id, input, dial, roots, guard, false)
}

func (registry *Registry) reserve(ctx context.Context, id uint64, input Request, dial Dial, roots *x509.CertPool, guard Guard, peerGET bool) (*Operation, error) {
	deadline := time.Now().Add(maxDuration)
	if !validOperationID(id) {
		return nil, errOperationID
	}
	allowed := ctx != nil && dial != nil && roots != nil && guard != nil && guard()
	registry.mu.Lock()
	op, err := registry.reserveLocked(ctx, id, input, dial, roots, guard, allowed, deadline, peerGET)
	registry.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if !op.Current() {
		registry.withdraw(op)
		return nil, errStopped
	}
	return op, nil
}

// Current is an observation, not a JS publication commit. The bridge must also
// synchronously fence its original pending token, generation and lease at resolve.
func (op *Operation) Current() bool {
	if op == nil || op.registry == nil || op.ctx.Err() != nil || !op.guard() {
		return false
	}
	op.registry.mu.Lock()
	defer op.registry.mu.Unlock()
	return op.registry.liveLocked(op)
}

func (op *Operation) start() error {
	if op == nil || op.registry == nil {
		return errInput
	}
	if !op.Current() {
		op.registry.withdraw(op)
		return errStopped
	}
	op.registry.mu.Lock()
	defer op.registry.mu.Unlock()
	if !op.registry.liveLocked(op) {
		return errStopped
	}
	if op.phase != reserved {
		return errUsed
	}
	op.phase = running
	return nil
}

func (op *Operation) finish(response Response, err error) error {
	current := op.Current() // Supplied guard may reenter cancellation/Close.
	op.registry.mu.Lock()
	if !current || !op.registry.liveLocked(op) {
		err = errStopped
	}
	if err == nil {
		op.response, op.input, op.phase = response, Request{}, ready
		op.registry.mu.Unlock()
		return nil
	}
	cleanup := op.registry.retireLocked(op)
	op.registry.mu.Unlock()
	cleanup.run()
	return err
}

// Run is synchronous and one-shot. Cancellation withdraws the result promptly,
// but this slot survives until actual Do plus admitted dial/I/O/Close have ended.
func (op *Operation) Run() error {
	if err := op.start(); err != nil {
		return err
	}
	owner, err := newDrainingDial(op.dial)
	if err != nil {
		return op.finish(Response{}, err)
	}
	run := Do
	if op.peerGET {
		run = doPeerGET
	}
	response, err := run(op.ctx, op.input, owner.dial, op.roots, op.Current)
	drainErr := owner.sealAndWait()
	op.drainFailed = drainErr != nil
	if err == nil {
		err = drainErr
	}
	return op.finish(response, err)
}

// Borrow grants one scoped readonly response after physical drain. Its slices
// must not be mutated or retained after Release. Cancel may revoke Current while
// copying; no bytes are concurrently cleared, and the slot survives until Release.
func (op *Operation) Borrow() (Response, error) {
	if op == nil || op.registry == nil {
		return Response{}, errInput
	}
	if !op.Current() {
		op.registry.withdraw(op)
		return Response{}, errStopped
	}
	op.registry.mu.Lock()
	defer op.registry.mu.Unlock()
	if !op.registry.liveLocked(op) {
		return Response{}, errStopped
	}
	if op.phase != ready || op.stream != nil {
		return Response{}, errUsed
	}
	op.phase = publishing
	return op.response, nil
}

func (op *Operation) Release() bool {
	if op == nil || op.registry == nil {
		return false
	}
	op.registry.mu.Lock()
	if op.registry.ops[op.id] != op || op.phase != ready && op.phase != publishing {
		op.registry.mu.Unlock()
		return false
	}
	cleanup := op.registry.retireLocked(op)
	op.registry.mu.Unlock()
	cleanup.run()
	return true
}

// Cancel of an unknown higher safe ID burns it and all lower IDs, without adding
// an entry. A cancel-before-reserve or out-of-order caller therefore fails closed.
func (registry *Registry) Cancel(id uint64) bool {
	if !validOperationID(id) {
		return false
	}
	registry.mu.Lock()
	if id > registry.high {
		registry.high = id
	}
	op := registry.ops[id]
	registry.mu.Unlock()
	return op != nil && registry.withdraw(op)
}

func (registry *Registry) Close() {
	registry.mu.Lock()
	if registry.closed {
		registry.mu.Unlock()
		return
	}
	registry.closed = true
	cleanups := make([]operationCleanup, 0, len(registry.ops))
	for _, op := range registry.ops {
		if !op.stopped {
			cleanups = append(cleanups, registry.stopLocked(op))
		}
	}
	registry.mu.Unlock()
	for _, cleanup := range cleanups {
		cleanup.run()
	}
}
