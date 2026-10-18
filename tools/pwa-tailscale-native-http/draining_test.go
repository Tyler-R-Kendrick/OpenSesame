package nativehttp

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type physicalConn struct {
	net.Conn
	readHeld, readRelease, closeHeld, closeRelease, closeReturned chan struct{}
	armRead, armWrite                                             atomic.Bool
	writeHeld, writeRelease                                       chan struct{}
	reads, writes, closes                                         atomic.Int32
	closeError                                                    error
}

func physical(conn net.Conn) *physicalConn {
	return &physicalConn{Conn: conn, readHeld: make(chan struct{}), readRelease: make(chan struct{}),
		writeHeld: make(chan struct{}), writeRelease: make(chan struct{}),
		closeHeld: make(chan struct{}), closeRelease: make(chan struct{}), closeReturned: make(chan struct{})}
}

func (conn *physicalConn) Read(buffer []byte) (int, error) {
	conn.reads.Add(1)
	n, err := conn.Conn.Read(buffer)
	if conn.armRead.Swap(false) {
		close(conn.readHeld)
		<-conn.readRelease
	}
	return n, err
}

func (conn *physicalConn) Write(buffer []byte) (int, error) {
	conn.writes.Add(1)
	n, err := conn.Conn.Write(buffer)
	if conn.armWrite.Swap(false) {
		close(conn.writeHeld)
		<-conn.writeRelease
	}
	return n, err
}

func (conn *physicalConn) Close() error {
	conn.closes.Add(1)
	err := conn.Conn.Close()
	close(conn.closeHeld) // The actual TCP Close has returned; this wrapper has not.
	<-conn.closeRelease
	close(conn.closeReturned)
	if conn.closeError != nil {
		return conn.closeError
	}
	return err
}

func release(signal chan struct{}) {
	select {
	case <-signal:
	default:
		close(signal)
	}
}

func pending(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Fatal("Physical ownership retired before its held return boundary.")
	default:
	}
}

type drainingResult struct {
	done chan struct{}
	err  error
}

func drain(owner *drainingDial) *drainingResult {
	result := &drainingResult{done: make(chan struct{})}
	go func() {
		result.err = owner.sealAndWait()
		close(result.done)
	}()
	return result
}

func ownerFor(t *testing.T, dial Dial) *drainingDial {
	t.Helper()
	owner, err := newDrainingDial(dial)
	if err != nil {
		t.Fatal("Owned dialer was refused.")
	}
	return owner
}

func TestPhysicalDrainPreservesRealHTTPSAndFencesFurtherIO(t *testing.T) {
	body := []byte{0, 255, 195, 169, '%', '+'}
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), roundTripHandler(t, body))
	var socket *physicalConn
	owner := ownerFor(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := fixture.dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		socket = physical(conn)
		release(socket.closeRelease)
		return socket, nil
	})
	request := Request{Method: "POST", URL: fixture.url + "/a%2Fb?form=%C3%A9%00%2B+",
		Headers: []Header{{"Authorization", "Bearer secret%2B+"}, {"X-Repeat", "one"}, {"X-Repeat", "two"}, {"X-UTF8", "café"}}, Body: body}
	response, err := Do(context.Background(), request, owner.dial, fixture.roots, func() bool { return true })
	roundTripResult(t, request, response, err)
	if err := owner.sealAndWait(); err != nil || socket.closes.Load() != 1 {
		t.Fatal("Successful actual HTTPS did not drain its owned socket exactly once.")
	}
	if !bytes.Equal(response.Body, body) {
		t.Fatal("Physical accounting changed binary response bytes.")
	}
	if conn, err := owner.dial(context.Background(), "tcp", "refused"); conn != nil || err != errStopped {
		t.Fatal("A sealed dial reached its underlying target.")
	}
	if err := owner.sealAndWait(); err != nil {
		t.Fatal("Repeated drain did not retain the actual cleanup outcome.")
	}
}

func TestPhysicalDrainWaitsForCancelledAdmittedDialAndLateClose(t *testing.T) {
	var requests atomic.Int32
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(http.ResponseWriter, *http.Request) { requests.Add(1) })
	established, dialRelease := make(chan struct{}), make(chan struct{})
	var socket *physicalConn
	var calls atomic.Int32
	owner := ownerFor(t, func(_ context.Context, network, address string) (net.Conn, error) {
		calls.Add(1)
		conn, err := fixture.dial(context.Background(), network, address)
		if err != nil {
			return nil, err
		}
		socket = physical(conn)
		close(established)
		<-dialRelease // Deliberately ignore cancellation after real TCP establishment.
		return socket, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	done, result := make(chan struct{}), outcome{}
	go func() {
		result.response, result.err = Do(ctx, Request{Method: "GET", URL: fixture.url}, owner.dial, fixture.roots, func() bool { return true })
		close(done)
	}()
	var draining *drainingResult
	defer func() {
		cancel()
		release(dialRelease)
		if socket != nil {
			release(socket.closeRelease)
		}
		waitSignal(t, done)
		if draining != nil {
			waitSignal(t, draining.done)
		}
	}()
	waitSignal(t, established)
	cancel()
	waitSignal(t, done)
	failed(t, result.response, result.err)
	owner.seal() // Establish the admission fence synchronously, not by scheduling.
	draining = drain(owner)
	pending(t, owner.done)
	independent := ownerFor(t, fixture.dial)
	response, err := Do(context.Background(), Request{Method: "GET", URL: fixture.url}, independent.dial, fixture.roots, func() bool { return true })
	if err != nil || response.Status != http.StatusOK || independent.sealAndWait() != nil {
		t.Fatal("A held cancelled dial blocked an independent real HTTPS operation.")
	}
	release(dialRelease)
	waitSignal(t, socket.closeHeld)
	pending(t, owner.done)
	release(socket.closeRelease)
	waitSignal(t, draining.done)
	if draining.err != nil || socket.closes.Load() != 1 || requests.Load() != 1 {
		t.Fatal("Late dial cleanup leaked, repeated or sent an unauthorized HTTP request.")
	}
	if conn, err := owner.dial(context.Background(), "tcp", "refused"); conn != nil || err != errStopped || calls.Load() != 1 {
		t.Fatal("Post-seal dial invoked the underlying callback.")
	}
}

func TestPhysicalDrainWaitsForActualCloseAndAdmittedReadReturn(t *testing.T) {
	var socket *physicalConn
	connected := make(chan struct{})
	serverClosed := make(chan struct{})
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(writer http.ResponseWriter, request *http.Request) {
		<-connected
		socket.armRead.Store(true)
		writer.Header().Set("Content-Length", "2")
		writer.Write([]byte("ok"))
		writer.(http.Flusher).Flush()
		<-request.Context().Done()
		close(serverClosed)
	})
	owner := ownerFor(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := fixture.dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		socket = physical(conn)
		close(connected)
		return socket, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	done, result := make(chan struct{}), outcome{}
	go func() {
		result.response, result.err = Do(ctx, Request{Method: "GET", URL: fixture.url}, owner.dial, fixture.roots, func() bool { return true })
		close(done)
	}()
	var draining *drainingResult
	defer func() {
		cancel()
		if socket != nil {
			release(socket.closeRelease)
			release(socket.readRelease)
		}
		waitSignal(t, done)
		if draining != nil {
			waitSignal(t, draining.done)
		}
	}()
	waitSignal(t, connected)
	waitSignal(t, socket.readHeld)
	cancel()
	waitSignal(t, socket.closeHeld)
	owner.seal()
	draining = drain(owner)
	pending(t, owner.done)
	release(socket.closeRelease)
	waitSignal(t, socket.closeReturned)
	waitSignal(t, serverClosed)
	pending(t, owner.done) // Closing the socket cannot retire the admitted Read.
	release(socket.readRelease)
	waitSignal(t, done)
	failed(t, result.response, result.err)
	waitSignal(t, draining.done)
	if draining.err != nil || socket.closes.Load() != 1 {
		t.Fatal("Cancelled real body did not close and drain exactly once.")
	}
}

func TestPhysicalDrainConcurrentCloseAndCleanupFailure(t *testing.T) {
	for _, failClose := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "opaque-failure"}[failClose], func(t *testing.T) {
			fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(http.ResponseWriter, *http.Request) {})
			var socket *physicalConn
			owner := ownerFor(t, func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, err := fixture.dial(ctx, network, address)
				if err != nil {
					return nil, err
				}
				socket = physical(conn)
				if failClose {
					socket.closeError = errors.New("opaque provider detail must never escape")
				}
				return socket, nil
			})
			conn, err := owner.dial(context.Background(), "tcp", fixture.url[len("https://"):])
			if err != nil {
				t.Fatal("Actual owned TCP setup failed.")
			}
			first, second := make(chan struct{}), make(chan struct{})
			var firstErr, secondErr error
			go func() { firstErr = conn.Close(); close(first) }()
			defer func() { release(socket.closeRelease); waitSignal(t, first); waitSignal(t, second) }()
			waitSignal(t, socket.closeHeld)
			go func() { secondErr = conn.Close(); close(second) }()
			owner.seal()
			pending(t, owner.done)
			reads, writes := socket.reads.Load(), socket.writes.Load()
			if _, err := conn.Read(make([]byte, 1)); err != errStopped {
				t.Fatal("Post-seal Read reached an underlying socket.")
			}
			if _, err := conn.Write([]byte("private")); err != errStopped || socket.reads.Load() != reads || socket.writes.Load() != writes {
				t.Fatal("Post-seal I/O was not fenced before actual I/O.")
			}
			release(socket.closeRelease)
			waitSignal(t, first)
			waitSignal(t, second)
			err = owner.sealAndWait()
			want := error(nil)
			if failClose {
				want = errNetwork
			}
			if firstErr != want || secondErr != want || err != want || socket.closes.Load() != 1 {
				t.Fatal("Concurrent Close did not own one actual sanitized completion.")
			}
		})
	}
}

func TestPhysicalDrainRejectsNilDial(t *testing.T) {
	if owner, err := newDrainingDial(nil); owner != nil || err != errInput {
		t.Fatal("Missing dial authority was accepted.")
	}
}

func TestPhysicalDrainOwnsActualWriteUntilReturn(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(http.ResponseWriter, *http.Request) {})
	var socket *physicalConn
	owner := ownerFor(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := fixture.dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		socket = physical(conn)
		release(socket.closeRelease)
		return socket, nil
	})
	conn, err := owner.dial(context.Background(), "tcp", fixture.url[len("https://"):])
	if err != nil {
		t.Fatal("Actual owned TCP setup failed.")
	}
	socket.armWrite.Store(true)
	written := make(chan struct{})
	var count int
	go func() { count, err = conn.Write([]byte{0}); close(written) }()
	var draining *drainingResult
	defer func() {
		release(socket.writeRelease)
		conn.Close()
		waitSignal(t, written)
		if draining != nil {
			waitSignal(t, draining.done)
		}
	}()
	waitSignal(t, socket.writeHeld)
	owner.seal()
	draining = drain(owner)
	waitSignal(t, socket.closeReturned)
	pending(t, owner.done)
	release(socket.writeRelease)
	waitSignal(t, written)
	waitSignal(t, draining.done)
	if count != 1 || err != nil || draining.err != nil || socket.closes.Load() != 1 {
		t.Fatal("An admitted actual TCP Write did not retain ownership until return.")
	}
}

func TestPhysicalDrainClosesConnectionReturnedWithError(t *testing.T) {
	fixture := newTarget(t, "native.test", time.Now().Add(time.Hour), func(http.ResponseWriter, *http.Request) {})
	var socket *physicalConn
	owner := ownerFor(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := fixture.dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		socket = physical(conn)
		release(socket.closeRelease)
		return socket, errors.New("opaque dial error must never escape")
	})
	conn, err := owner.dial(context.Background(), "tcp", fixture.url[len("https://"):])
	if conn != nil || err != errNetwork || socket.closes.Load() != 1 || owner.sealAndWait() != nil {
		t.Fatal("A dial returning both connection and error leaked authority or raw details.")
	}
}
