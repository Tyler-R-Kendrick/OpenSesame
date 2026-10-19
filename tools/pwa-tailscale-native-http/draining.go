package nativehttp

import (
	"context"
	"net"
	"sync"
)

// drainingDial owns physical work after an HTTP operation has stopped returning
// results. Its caller must still cancel the operation context before draining.
// A callback that ignores cancellation keeps its physical ownership until return.
type drainingDial struct {
	mu      sync.Mutex
	next    Dial
	sealed  bool
	active  int
	conns   map[*drainingConn]struct{}
	done    chan struct{}
	failure error
}

func newDrainingDial(next Dial) (*drainingDial, error) {
	if next == nil {
		return nil, errInput
	}
	return &drainingDial{next: next, conns: make(map[*drainingConn]struct{}), done: make(chan struct{})}, nil
}

// admission and retirement share one lock; no Add can race a zero-count wait.
func (owner *drainingDial) admit(conn *drainingConn) bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.sealed || conn != nil && conn.closing {
		return false
	}
	owner.active++
	return true
}

func (owner *drainingDial) completed() {
	if owner.sealed && owner.active == 0 {
		close(owner.done)
	}
}

func (owner *drainingDial) finish() {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	owner.active--
	owner.completed()
}

func (owner *drainingDial) cleanup(err error) {
	if err == nil {
		return
	}
	owner.mu.Lock()
	owner.failure = errNetwork
	owner.mu.Unlock()
}

func (owner *drainingDial) dial(ctx context.Context, network, address string) (net.Conn, error) {
	if !owner.admit(nil) {
		return nil, errStopped
	}
	defer owner.finish()
	conn, err := owner.next(ctx, network, address)
	if conn == nil {
		return nil, errNetwork
	}
	owner.mu.Lock()
	if owner.sealed || err != nil {
		owner.mu.Unlock()
		owner.cleanup(conn.Close())
		return nil, errNetwork
	}
	wrapped := &drainingConn{Conn: conn, owner: owner}
	owner.conns[wrapped] = struct{}{}
	owner.active++ // Transfer connection lifetime before retiring the dial owner.
	owner.mu.Unlock()
	return wrapped, nil
}

// seal is synchronous so later registry cancellation can fence admission before
// starting any cleanup goroutine. No caller callback runs under the owner lock.
func (owner *drainingDial) seal() []*drainingConn {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if !owner.sealed {
		owner.sealed = true
		owner.completed()
	}
	conns := make([]*drainingConn, 0, len(owner.conns))
	for conn := range owner.conns {
		conns = append(conns, conn)
	}
	return conns
}

func (owner *drainingDial) sealAndWait() error {
	for _, conn := range owner.seal() {
		conn.Close()
	}
	<-owner.done
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.failure
}

type drainingConn struct {
	net.Conn
	owner   *drainingDial
	closing bool // Protected by owner.mu, including concurrent I/O admission.
	once    sync.Once
	failure error // Published to every Close caller by once.Do completion.
}

func (conn *drainingConn) Close() error {
	conn.once.Do(func() {
		conn.owner.mu.Lock()
		conn.closing = true
		conn.owner.mu.Unlock()
		err := conn.Conn.Close()
		conn.owner.mu.Lock()
		defer conn.owner.mu.Unlock()
		if err != nil {
			conn.failure = errNetwork
			conn.owner.failure = errNetwork
		}
		delete(conn.owner.conns, conn)
		conn.owner.active--
		conn.owner.completed()
	})
	return conn.failure
}

func (conn *drainingConn) transfer(buffer []byte, action func([]byte) (int, error)) (int, error) {
	if !conn.owner.admit(conn) {
		return 0, errStopped
	}
	defer conn.owner.finish()
	return action(buffer)
}

func (conn *drainingConn) Read(buffer []byte) (int, error) {
	return conn.transfer(buffer, conn.Conn.Read)
}

func (conn *drainingConn) Write(buffer []byte) (int, error) {
	return conn.transfer(buffer, conn.Conn.Write)
}
