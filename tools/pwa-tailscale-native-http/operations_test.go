package nativehttp

import (
	"bytes"
	"context"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func reserveOperation(t *testing.T, registry *Registry, id uint64, fixture target) *Operation {
	t.Helper()
	op, err := registry.Reserve(context.Background(), id, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
	if err != nil {
		t.Fatal("Owned operation was not admitted.")
	}
	return op
}

type operationRun struct {
	done chan struct{}
	err  error
}

func runOperation(op *Operation) *operationRun {
	run := &operationRun{done: make(chan struct{})}
	go func() { run.err = op.Run(); close(run.done) }()
	return run
}

func noBorrow(t *testing.T, op *Operation) {
	t.Helper()
	response, err := op.Borrow()
	if err != errStopped || response.Status != 0 || len(response.Body) != 0 || len(response.Headers) != 0 || response.URL != "" || response.Reason != "" {
		t.Fatal("Withdrawn operation exposed a late or partial response.")
	}
}

func assertRejectedIDs(t *testing.T, registry *Registry, fixture target) {
	t.Helper()
	request, dial, allow := Request{Method: "GET", URL: fixture.url}, fixture.dial, func() bool { return true }
	for _, id := range []uint64{0, maxOperationID + 1} {
		if op, err := registry.Reserve(context.Background(), id, request, dial, fixture.roots, allow); op != nil || err != errOperationID {
			t.Fatal("An unsafe ID was admitted.")
		}
	}
	if _, err := registry.Reserve(nil, 1, request, dial, fixture.roots, allow); err != errInput {
		t.Fatal("Missing context was admitted.")
	}
	if _, err := registry.Reserve(context.Background(), 1, request, dial, fixture.roots, allow); err != errOperationID {
		t.Fatal("Rejected configuration did not consume its ID.")
	}
	oversized := Request{Method: "POST", URL: fixture.url, Body: make([]byte, maxRequest+1)}
	if _, err := registry.Reserve(context.Background(), 2, oversized, dial, fixture.roots, allow); err != errInput {
		t.Fatal("An oversized snapshot was admitted.")
	}
}

func TestRegistryMissingDialTrustOrGuardAreRefused(t *testing.T) {
	for _, missing := range []string{"dial", "roots", "guard"} {
		registry := &Registry{}
		dial, roots, guard := Dial(func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("Missing authority dialed.")
			return nil, errNetwork
		}), x509.NewCertPool(), Guard(func() bool { return true })
		switch missing {
		case "dial":
			dial = nil
		case "roots":
			roots = nil
		case "guard":
			guard = nil
		}
		if op, err := registry.Reserve(context.Background(), 1, Request{Method: "GET", URL: "https://native.test"}, dial, roots, guard); op != nil || err != errInput {
			t.Fatal("Incomplete authority was admitted.")
		}
		registry.Close()
	}
}

func borrowBinary(t *testing.T, op *Operation, status, repeats int) Response {
	t.Helper()
	response, err := op.Borrow()
	if err != nil || response.Status != status || !bytes.Equal(response.Body, []byte{0, 255}) || len(values(response.Headers, "X-Repeat")) != repeats {
		t.Fatal("Actual binary/header result did not survive its scoped borrow.")
	}
	if _, err := op.Borrow(); err != errUsed {
		t.Fatal("A result was borrowed twice.")
	}
	return response
}

func revokeUnstarted(t *testing.T, registry *Registry, op *Operation) {
	t.Helper()
	if !registry.Cancel(op.id) || registry.Cancel(op.id) || op.Run() != errStopped || op.Release() {
		t.Fatal("Cancellation did not revoke the exact unstarted entry.")
	}
}

func assertRevokedBorrow(t *testing.T, op *Operation, borrowed Response, err error) {
	t.Helper()
	pending(t, op.retired)
	if err != errCapacity || !bytes.Equal(borrowed.Body, []byte{0, 255}) || !op.Release() || op.Release() {
		t.Fatal("A revoked borrowed body freed capacity or changed during copying.")
	}
}

func TestRegistryIDsAdmissionAndNoCanceledStartIO(t *testing.T) {
	var calls atomic.Int32
	dial := func(context.Context, string, string) (net.Conn, error) { calls.Add(1); return nil, errNetwork }
	fixture := target{url: "https://native.test", roots: x509.NewCertPool(), dial: dial}
	registry := &Registry{}
	defer registry.Close()
	request := Request{Method: "GET", URL: fixture.url}
	allow := func() bool { return true }
	assertRejectedIDs(t, registry, fixture)
	if registry.Cancel(10) || registry.Cancel(maxOperationID+1) {
		t.Fatal("Unknown cancellation claimed a live operation.")
	}
	if _, err := registry.Reserve(context.Background(), 10, request, dial, fixture.roots, allow); err != errOperationID {
		t.Fatal("Cancel-before-reserve did not fail closed.")
	}
	var held []*Operation
	for id := uint64(11); id <= 14; id++ {
		held = append(held, reserveOperation(t, registry, id, fixture))
	}
	if _, err := registry.Reserve(context.Background(), 15, request, dial, fixture.roots, allow); err != errCapacity {
		t.Fatal("A fifth reservation was admitted.")
	}
	revokeUnstarted(t, registry, held[0])
	if _, err := registry.Reserve(context.Background(), 15, request, dial, fixture.roots, allow); err != errOperationID {
		t.Fatal("Capacity rejection did not consume its ID.")
	}
	last := reserveOperation(t, registry, maxOperationID, fixture)
	registry.Close()
	for _, op := range append(held, last) {
		if op.Run() != errStopped || op.Current() {
			t.Fatal("Closed generation started a reserved request.")
		}
	}
	if calls.Load() != 0 || registry.Cancel(maxOperationID) {
		t.Fatal("Rejected or closed work invoked a dial callback.")
	}
}

func TestRegistryBorrowAndCancellationRetainBoundedResults(t *testing.T) {
	for _, borrowFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "publishing"}[borrowFirst], func(t *testing.T) {
			var requests atomic.Int32
			fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				writer.Header().Add("X-Repeat", "one")
				writer.Header().Add("X-Repeat", "two")
				writer.WriteHeader(299)
				writer.Write([]byte{0, 255})
			})
			registry := &Registry{}
			defer registry.Close()
			op := reserveOperation(t, registry, 1, fixture)
			if op.Run() != nil || op.Run() != errUsed {
				t.Fatal("One-shot actual HTTPS did not complete exactly once.")
			}
			var borrowed Response
			if borrowFirst {
				borrowed = borrowBinary(t, op, 299, 2)
			}
			for id := uint64(2); id <= 4; id++ {
				reserveOperation(t, registry, id, fixture)
			}
			if !registry.Cancel(1) || op.Current() {
				t.Fatal("Result cancellation did not withdraw its original authority.")
			}
			_, err := registry.Reserve(context.Background(), 5, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
			if borrowFirst {
				assertRevokedBorrow(t, op, borrowed, err)
			} else if err != nil || op.Release() {
				t.Fatal("An unborrowed withdrawn result retained capacity.")
			}
			if !borrowFirst {
				registry.Cancel(5)
			}
			reserveOperation(t, registry, 6, fixture)
			noBorrow(t, op)
			if requests.Load() != 1 {
				t.Fatal("Reservation or duplicate Run performed extra HTTPS requests.")
			}
		})
	}
}

func TestRegistrySnapshotTrustAndReentrantGuard(t *testing.T) {
	var requests atomic.Int32
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		if request.Header.Get("Authorization") != "original" {
			t.Error("Caller mutation changed captured credentials.")
		}
		buffer := make([]byte, 2)
		if n, err := io.ReadFull(request.Body, buffer); err != nil || n != 2 || !bytes.Equal(buffer, []byte{0, 255}) {
			t.Error("Caller mutation changed captured body bytes.")
		}
		writer.Write([]byte("ok"))
	})
	registry := &Registry{}
	defer registry.Close()
	input := Request{Method: "POST", URL: fixture.url, Headers: []Header{{"Authorization", "original"}}, Body: []byte{0, 255}}
	op, err := registry.Reserve(context.Background(), 1, input, fixture.dial, fixture.roots, func() bool { return true })
	if err != nil {
		t.Fatal("Snapshot reservation failed.")
	}
	input.Body[0], input.Headers[0].Value = 1, "changed"
	if op.Run() != nil || !op.Release() {
		t.Fatal("Original snapshot did not complete actual HTTPS.")
	}
	untrusted := x509.NewCertPool()
	op, err = registry.Reserve(context.Background(), 2, input, fixture.dial, untrusted, func() bool { return true })
	if err != nil {
		t.Fatal("Explicit empty trust reservation failed.")
	}
	untrusted.AddCert(fixture.ca)
	if op.Run() != errNetwork || requests.Load() != 1 {
		t.Fatal("Later trust expansion authorized an original untrusted request.")
	}
	noBorrow(t, op)
	if _, err := registry.Reserve(context.Background(), 3, input, fixture.dial, fixture.roots, func() bool { registry.Cancel(3); return true }); err != errOperationID {
		t.Fatal("Reentrant cancel-before-reserve deadlocked or failed open.")
	}
}

func TestRegistryReservedAndReadyDeadlineRetirement(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) { writer.Write([]byte("ok")) })
	registry := &Registry{}
	defer registry.Close()
	for _, execute := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		id := uint64(1)
		if execute {
			id = 2
		}
		started := time.Now()
		op, err := registry.Reserve(ctx, id, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
		if err != nil {
			cancel()
			t.Fatal("Deadline reservation failed.")
		}
		deadline, ok := op.ctx.Deadline()
		if !ok || deadline.Before(started.Add(maxDuration)) || deadline.After(time.Now().Add(maxDuration)) {
			cancel()
			t.Fatal("Reservation did not bound the total operation lifetime.")
		}
		if execute && op.Run() != nil {
			cancel()
			t.Fatal("Ready deadline control failed actual HTTPS.")
		}
		cancel()
		waitSignal(t, op.retired)
		noBorrow(t, op)
		if op.Run() != errStopped {
			t.Fatal("Expired reservation restarted I/O.")
		}
	}
}

func TestRegistryBorrowedContextAndCloseKeepOriginalCapacity(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) { writer.Write([]byte{0, 255}) })
	registry := &Registry{}
	defer registry.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	op, err := registry.Reserve(ctx, 1, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
	if err != nil || op.Run() != nil {
		t.Fatal("Original borrowed-context control failed actual HTTPS.")
	}
	response := borrowBinary(t, op, http.StatusOK, 0)
	cancel()
	waitSignal(t, op.ctx.Done())
	if op.Current() {
		t.Fatal("Cancelled caller context retained publication authority.")
	}
	pending(t, op.retired)
	for id := uint64(2); id <= 4; id++ {
		reserveOperation(t, registry, id, fixture)
	}
	_, err = registry.Reserve(context.Background(), 5, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, func() bool { return true })
	if err != errCapacity {
		t.Fatal("Caller cancellation reclaimed a borrowed physical slot.")
	}
	registry.Close()
	pending(t, op.retired)
	if !bytes.Equal(response.Body, []byte{0, 255}) || !op.Release() {
		t.Fatal("Closing a generation mutated or leaked its scoped borrowed response.")
	}
	waitSignal(t, op.retired)
	noBorrow(t, op)
}

func TestRegistryFourActualReadyBodiesAreBoundedAndGuardWithdraws(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) { writer.Write([]byte{0, 255}) })
	registry := &Registry{}
	defer registry.Close()
	var allowed atomic.Bool
	allowed.Store(true)
	var operations []*Operation
	for id := uint64(1); id <= 4; id++ {
		op, err := registry.Reserve(context.Background(), id, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, allowed.Load)
		if err != nil || op.Run() != nil {
			t.Fatal("Actual ready-body capacity control failed.")
		}
		operations = append(operations, op)
	}
	if _, err := registry.Reserve(context.Background(), 5, Request{Method: "GET", URL: fixture.url}, fixture.dial, fixture.roots, allowed.Load); err != errCapacity {
		t.Fatal("Four real ready results admitted another response body.")
	}
	allowed.Store(false)
	for _, op := range operations {
		noBorrow(t, op)
		waitSignal(t, op.retired)
	}
	reserveOperation(t, registry, 6, fixture)
}
