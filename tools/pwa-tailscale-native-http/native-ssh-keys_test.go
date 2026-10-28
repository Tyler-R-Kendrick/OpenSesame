package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"tailscale.com/tailcfg"
)

func nativeSSHTestSigner(t *testing.T, fill byte) ssh.Signer {
	t.Helper()
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{fill}, ed25519.SeedSize))
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func nativeSSHAdvertised(signer ssh.Signer) string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

func TestNativeSSHHostKeysRejectMissingMalformedAndUnadvertised(t *testing.T) {
	original, other := nativeSSHTestSigner(t, 1), nativeSSHTestSigner(t, 2)
	advertised := nativeSSHAdvertised(original)
	for _, values := range [][]string{nil, {"invalid"}, {advertised + "\n" + advertised}, {advertised, advertised}} {
		if _, err := parseNativeSSHHostKeys(values); err == nil {
			t.Fatalf("invalid key set was accepted: %q", values)
		}
	}
	keys, err := parseNativeSSHHostKeys([]string{advertised})
	if err != nil || keys.verify(original.PublicKey()) != nil || !errors.Is(keys.verify(other.PublicKey()), errNativeSSHHostKey) {
		t.Fatal("only the selected peer's advertised key may authenticate")
	}
}

func TestNativeSSHRealHandshakeUsesCurrentSelectedPeerKey(t *testing.T) {
	original, other := nativeSSHTestSigner(t, 3), nativeSSHTestSigner(t, 4)
	for _, scenario := range []struct {
		name        string
		server      ssh.Signer
		withdraw    bool
		wantSuccess bool
	}{
		{"advertised peer key", original, false, true},
		{"different server key", other, false, false},
		{"withdrawn peer route", original, true, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newPeerFixture()
			fixture.peer.Hostinfo = (&tailcfg.Hostinfo{SSH_HostKeys: []string{nativeSSHAdvertised(original)}}).View()
			peer, lifetime := authority(t)
			keys, err := parseNativeSSHHostKeys(fixture.peer.Hostinfo.SSH_HostKeys().AsSlice())
			if err != nil {
				t.Fatal(err)
			}
			peer.sshKeys = keys
			if !fixture.current(peer) {
				t.Fatal("initial peer was not authorized")
			}
			if scenario.withdraw {
				fixture.route = func(netip.Addr) (nativePeerRoute, bool) { return nativePeerRoute{}, false }
			}
			clientSocket, serverSocket := net.Pipe()
			defer clientSocket.Close()
			defer serverSocket.Close()
			_ = clientSocket.SetDeadline(time.Now().Add(5 * time.Second))
			_ = serverSocket.SetDeadline(time.Now().Add(5 * time.Second))
			stop := watchNativeSSHConnection(lifetime, clientSocket)
			defer stop()
			serverDone := make(chan error, 1)
			serverRelease := make(chan struct{})
			serverConfig := &ssh.ServerConfig{NoClientAuth: true}
			serverConfig.AddHostKey(scenario.server)
			go func() {
				connection, _, _, err := ssh.NewServerConn(serverSocket, serverConfig)
				serverDone <- err
				if err == nil {
					<-serverRelease
					connection.Close()
				}
			}()
			callbackCalled := false
			clientConfig := &ssh.ClientConfig{User: "test", HostKeyCallback: func(_ string, _ net.Addr, presented ssh.PublicKey) error {
				callbackCalled = true
				if !fixture.current(peer) {
					return errNativeSSHHostKey
				}
				return keys.verify(presented)
			}}
			connection, _, _, err := ssh.NewClientConn(clientSocket, "peer:22", clientConfig)
			ok := (err == nil) == scenario.wantSuccess
			if connection != nil {
				connection.Close()
			}
			clientSocket.Close()
			close(serverRelease)
			<-serverDone
			if !ok {
				t.Fatalf("handshake result %v, expected success %v", err, scenario.wantSuccess)
			}
			if !callbackCalled {
				t.Fatal("SSH handshake did not reach the host-key callback")
			}
		})
	}
}

func TestNativeSSHKeyRotationWithdrawsOriginalPeer(t *testing.T) {
	original, other := nativeSSHTestSigner(t, 5), nativeSSHTestSigner(t, 6)
	fixture := newPeerFixture()
	fixture.peer.Hostinfo = (&tailcfg.Hostinfo{SSH_HostKeys: []string{nativeSSHAdvertised(original)}}).View()
	peer, lifetime := authority(t)
	keys, err := parseNativeSSHHostKeys(fixture.peer.Hostinfo.SSH_HostKeys().AsSlice())
	if err != nil {
		t.Fatal(err)
	}
	peer.sshKeys = keys
	if !fixture.current(peer) {
		t.Fatal("original key must be authorized")
	}
	client, server := net.Pipe()
	defer server.Close()
	stop := watchNativeSSHConnection(lifetime, client)
	defer stop()
	fixture.peer = fixture.peer.Clone()
	fixture.peer.Hostinfo = (&tailcfg.Hostinfo{SSH_HostKeys: []string{nativeSSHAdvertised(other)}}).View()
	if fixture.current(peer) || lifetime.Err() == nil {
		t.Fatal("key rotation must withdraw the original session")
	}
	_ = server.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := server.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("withdrawal must close the actual connection: %v", err)
	}
}

func TestNativeSSHHandshakeTimeoutClosesStalledConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	stop := watchNativeSSHConnection(ctx, client)
	defer stop()
	config := &ssh.ClientConfig{User: "test", HostKeyCallback: func(_ string, _ net.Addr, _ ssh.PublicKey) error { return errNativeSSHHostKey }}
	if _, _, _, err := ssh.NewClientConn(client, "peer:22", config); err == nil || ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("stalled handshake must close on its original deadline: %v", err)
	}
}
