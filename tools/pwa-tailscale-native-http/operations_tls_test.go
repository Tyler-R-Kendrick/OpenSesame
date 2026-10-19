package nativehttp

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

type heldRegistryRequest struct {
	fixture                                         target
	socket                                          *physicalConn
	entered, dialRelease, serverClosed, bodyStarted chan struct{}
}

func heldRegistryTarget(t *testing.T, mode string) *heldRegistryRequest {
	held := &heldRegistryRequest{entered: make(chan struct{}), dialRelease: make(chan struct{}), serverClosed: make(chan struct{}), bodyStarted: make(chan struct{})}
	held.fixture = newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		<-held.entered
		if mode == "read" {
			held.socket.armRead.Store(true)
		}
		writer.Header().Set("Content-Length", "2")
		if mode == "deadline" {
			writer.WriteHeader(http.StatusOK)
		} else {
			writer.Write([]byte("ok"))
		}
		writer.(http.Flusher).Flush()
		close(held.bodyStarted)
		<-request.Context().Done()
		close(held.serverClosed)
	})
	next := held.fixture.dial
	held.fixture.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := next(ctx, network, address)
		if err != nil {
			return nil, err
		}
		held.socket = physical(conn)
		close(held.entered)
		if mode == "dial" {
			<-held.dialRelease
		}
		return held.socket, nil
	}
	return held
}

func TestRegistryCapacityTracksActualDrainAndOtherGenerationSurvives(t *testing.T) {
	for _, mode := range []string{"dial", "read", "close"} {
		t.Run(mode, func(t *testing.T) {
			held := heldRegistryTarget(t, mode)
			registry, other := &Registry{}, &Registry{}
			op := reserveOperation(t, registry, 1, held.fixture)
			run := runOperation(op)
			defer func() {
				registry.Close()
				other.Close()
				release(held.dialRelease)
				if held.socket != nil {
					release(held.socket.closeRelease)
					release(held.socket.readRelease)
				}
				waitSignal(t, run.done)
			}()
			waitSignal(t, held.entered)
			if mode == "read" {
				waitSignal(t, held.socket.readHeld)
			} else if mode == "close" {
				waitSignal(t, held.socket.closeHeld)
			}
			if op.Run() != errUsed {
				t.Fatal("Concurrent Run escaped original one-shot ownership.")
			}
			if !registry.Cancel(1) || op.Current() || op.Release() {
				t.Fatal("Running cancellation released physical ownership.")
			}
			for id := uint64(2); id <= 4; id++ {
				reserveOperation(t, registry, id, held.fixture)
			}
			if _, err := registry.Reserve(context.Background(), 5, Request{Method: "GET", URL: held.fixture.url}, held.fixture.dial, held.fixture.roots, func() bool { return true }); err != errCapacity {
				t.Fatal("A cancelled but physically draining operation admitted a fifth slot.")
			}
			fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) { writer.Write([]byte{0, 255}) })
			independent := reserveOperation(t, other, 1, fixture)
			if independent.Run() != nil {
				t.Fatal("Cancellation affected another original registry's real HTTPS.")
			}
			release(held.dialRelease)
			waitSignal(t, held.socket.closeHeld)
			pending(t, op.retired)
			release(held.socket.closeRelease)
			waitSignal(t, held.socket.closeReturned)
			if mode == "read" {
				pending(t, op.retired)
				release(held.socket.readRelease)
			}
			waitSignal(t, run.done)
			waitSignal(t, op.retired)
			if mode != "dial" {
				waitSignal(t, held.serverClosed)
			}
			if run.err != errStopped {
				t.Fatal("Cancelled Run published a late successful result.")
			}
			noBorrow(t, op)
			reserveOperation(t, registry, 6, held.fixture)
			registry.Close()
			borrowBinary(t, independent, http.StatusOK, 0)
			if !independent.Current() || !independent.Release() {
				t.Fatal("Closing another generation withdrew this original result.")
			}
		})
	}
}

func TestRegistryEarlierDeadlineClosesActualBlockedBody(t *testing.T) {
	held := heldRegistryTarget(t, "deadline")
	registry := &Registry{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	op, err := registry.Reserve(ctx, 1, Request{Method: "GET", URL: held.fixture.url}, held.fixture.dial, held.fixture.roots, func() bool { return true })
	if err != nil {
		t.Fatal("Earlier deadline reservation failed.")
	}
	parentDeadline, _ := ctx.Deadline()
	actualDeadline, _ := op.ctx.Deadline()
	if !actualDeadline.Equal(parentDeadline) {
		t.Fatal("Reservation replaced its caller's earlier deadline.")
	}
	run := runOperation(op)
	defer func() {
		cancel()
		registry.Close()
		if held.socket != nil {
			release(held.socket.closeRelease)
		}
		waitSignal(t, run.done)
	}()
	waitSignal(t, held.entered)
	release(held.socket.closeRelease)
	waitSignal(t, held.bodyStarted)
	waitSignal(t, run.done)
	waitSignal(t, held.serverClosed)
	waitSignal(t, op.retired)
	if run.err != errStopped || ctx.Err() != context.DeadlineExceeded {
		t.Fatal("Actual blocked-body deadline failed to withdraw and drain the request.")
	}
	noBorrow(t, op)
}
