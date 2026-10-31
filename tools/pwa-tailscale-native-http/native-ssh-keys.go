package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"sort"
	"strings"

	"golang.org/x/crypto/ssh"
)

var errNativeSSHHostKey = errors.New("SSH peer host key is not authorized")

// nativeSSHHostKeys is an immutable copy of the selected peer's advertised
// keys. Only exactly parsed public keys are accepted; no caller supplies trust.
type nativeSSHHostKeys struct {
	keys []string
}

// Closing the original socket on withdrawal ends both handshake and session.
func watchNativeSSHConnection(ctx context.Context, conn net.Conn) func() bool {
	return context.AfterFunc(ctx, func() { _ = conn.Close() })
}

func parseNativeSSHHostKeys(advertised []string) (*nativeSSHHostKeys, error) {
	if len(advertised) == 0 || len(advertised) > 32 {
		return nil, errNativeSSHHostKey
	}
	keys := make([]string, 0, len(advertised))
	for _, value := range advertised {
		if len(value) == 0 || len(value) > 16384 || strings.ContainsAny(value, "\r\n") {
			return nil, errNativeSSHHostKey
		}
		key, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(value))
		if err != nil || len(options) != 0 || len(bytes.TrimSpace(rest)) != 0 {
			return nil, errNativeSSHHostKey
		}
		keys = append(keys, string(key.Marshal()))
	}
	sort.Strings(keys)
	for i := 1; i < len(keys); i++ {
		if keys[i] == keys[i-1] {
			return nil, errNativeSSHHostKey
		}
	}
	return &nativeSSHHostKeys{keys: keys}, nil
}

func (k *nativeSSHHostKeys) equal(other *nativeSSHHostKeys) bool {
	if k == nil || other == nil || len(k.keys) != len(other.keys) {
		return false
	}
	for i := range k.keys {
		if k.keys[i] != other.keys[i] {
			return false
		}
	}
	return true
}

func (k *nativeSSHHostKeys) verify(key ssh.PublicKey) error {
	if k != nil && key != nil {
		wire := string(key.Marshal())
		i := sort.SearchStrings(k.keys, wire)
		if i < len(k.keys) && k.keys[i] == wire {
			return nil
		}
	}
	return errNativeSSHHostKey
}
