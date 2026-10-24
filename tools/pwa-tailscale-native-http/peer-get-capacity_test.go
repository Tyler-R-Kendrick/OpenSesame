package nativehttp

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestPeerGETCapacityAndSeparateRegistryAuthority(t *testing.T) {
	var registry, other Registry
	dial := func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("not dialed") }
	guard := func() bool { return true }
	for id := uint64(1); id <= 4; id++ {
		if _, err := registry.ReservePeerGET(context.Background(), id, "http://100.64.0.1/", dial, guard); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := registry.ReservePeerGET(context.Background(), 5, "http://100.64.0.1/", dial, guard); err != errCapacity {
		t.Fatal("Peer capacity not bounded")
	}
	registry.Close()
	if _, err := other.ReservePeerGET(context.Background(), 1, "http://100.64.0.2/", dial, guard); err != nil {
		t.Fatal("Closing one registry affected another")
	}
	other.Close()
}
