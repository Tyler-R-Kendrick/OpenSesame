package nativehttp

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

type heldStream struct {
	fixture                                target
	socket                                 *physicalConn
	headers, writeEvent, closed, connected chan struct{}
}

func heldStreamTarget(t *testing.T) *heldStream {
	t.Helper()
	held := &heldStream{headers: make(chan struct{}), writeEvent: make(chan struct{}), closed: make(chan struct{}), connected: make(chan struct{})}
	held.fixture = newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(200)
		writer.(http.Flusher).Flush()
		close(held.headers)
		select {
		case <-held.writeEvent:
			writer.Write([]byte("event: message\ndata: held\n\n"))
			writer.(http.Flusher).Flush()
		case <-request.Context().Done():
		}
		<-request.Context().Done()
		close(held.closed)
	})
	next := held.fixture.dial
	held.fixture.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := next(ctx, network, address)
		if err != nil {
			return nil, err
		}
		held.socket = physical(conn)
		close(held.connected)
		return held.socket, nil
	}
	return held
}

func TestStreamCancelRetainsCapacityUntilRealReadAndCloseReturn(t *testing.T) {
	for _, mode := range []string{"close", "read"} {
		t.Run(mode, func(t *testing.T) {
			held := heldStreamTarget(t)
			registry, other := &Registry{}, &Registry{}
			op := openOwnedStream(t, registry, held.fixture)
			waitSignal(t, held.connected)
			waitSignal(t, held.headers)
			var pulling chan struct{}
			var pullErr error
			defer func() {
				registry.Close()
				other.Close()
				release(held.writeEvent)
				release(held.socket.closeRelease)
				release(held.socket.readRelease)
				if pulling != nil {
					waitSignal(t, pulling)
				}
				waitSignal(t, op.retired)
			}()
			if mode == "read" {
				held.socket.armRead.Store(true)
				pulling = make(chan struct{})
				go func() { _, pullErr = op.Pull(1); close(pulling) }()
				close(held.writeEvent)
				waitSignal(t, held.socket.readHeld)
			}
			if !registry.Cancel(1) || op.Current() || op.Release() {
				t.Fatal("Stream cancellation released physical ownership early.")
			}
			waitSignal(t, held.socket.closeHeld)
			pending(t, op.retired)
			for id := uint64(2); id <= 4; id++ {
				reserveOperation(t, registry, id, held.fixture)
			}
			if _, err := registry.Reserve(context.Background(), 5, Request{Method: "GET", URL: held.fixture.url}, held.fixture.dial, held.fixture.roots, func() bool { return true }); err != errCapacity {
				t.Fatal("Physically draining stream admitted a fifth slot.")
			}
			fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, _ *http.Request) { writer.Write([]byte("independent")) })
			independent := reserveOperation(t, other, 1, fixture)
			if independent.Run() != nil {
				t.Fatal("One stream cancellation affected another registry.")
			}
			release(held.socket.closeRelease)
			waitSignal(t, held.socket.closeReturned)
			if mode == "read" {
				pending(t, op.retired)
				release(held.socket.readRelease)
				waitSignal(t, pulling)
				if pullErr != errStopped {
					t.Fatal("Withdrawn credit exposed a late body chunk.")
				}
			}
			waitSignal(t, op.retired)
			waitSignal(t, held.closed)
			if !independent.Current() || !independent.Release() {
				t.Fatal("Original stream cleanup adopted a different generation.")
			}
		})
	}
}

func TestStreamRejectsConcurrentOrReplayedCreditWithoutExtraRead(t *testing.T) {
	held := heldStreamTarget(t)
	registry := &Registry{}
	op := openOwnedStream(t, registry, held.fixture)
	defer func() {
		registry.Close()
		release(held.writeEvent)
		release(held.socket.readRelease)
		release(held.socket.closeRelease)
		waitSignal(t, op.retired)
	}()
	held.socket.armRead.Store(true)
	first := make(chan struct{})
	second := make(chan struct{})
	var firstErr, secondErr error
	go func() { _, firstErr = op.Pull(1); close(first) }()
	close(held.writeEvent)
	waitSignal(t, held.socket.readHeld)
	reads := held.socket.reads.Load()
	go func() { _, secondErr = op.Pull(1); close(second) }()
	waitSignal(t, held.socket.closeHeld)
	pending(t, op.retired)
	release(held.socket.closeRelease)
	release(held.socket.readRelease)
	waitSignal(t, first)
	waitSignal(t, second)
	waitSignal(t, op.retired)
	if firstErr != errStopped || secondErr != errUsed || held.socket.reads.Load() != reads {
		t.Fatal("Concurrent credit performed another socket read or published stale data.")
	}
}

func TestStreamEarlierDeadlineDrainsIdleBodyWithoutPull(t *testing.T) {
	held := heldStreamTarget(t)
	registry := &Registry{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	op, err := registry.Reserve(ctx, 1, Request{Method: "GET", URL: held.fixture.url}, held.fixture.dial, held.fixture.roots, func() bool { return true })
	if err != nil {
		t.Fatal("Owned earlier stream deadline was not admitted.")
	}
	defer func() {
		registry.Close()
		release(held.writeEvent)
		if held.socket != nil {
			release(held.socket.closeRelease)
		}
		waitSignal(t, op.retired)
	}()
	if _, err := op.OpenStream(); err != nil {
		t.Fatal("Headers did not arrive before the idle body deadline.")
	}
	expected, _ := ctx.Deadline()
	actual, _ := op.ctx.Deadline()
	if !expected.Equal(actual) {
		t.Fatal("Streaming changed the original earlier deadline.")
	}
	release(held.socket.closeRelease)
	waitSignal(t, op.retired)
	waitSignal(t, held.closed)
	if ctx.Err() != context.DeadlineExceeded || op.Current() {
		t.Fatal("Idle stream survived its original deadline.")
	}
}
