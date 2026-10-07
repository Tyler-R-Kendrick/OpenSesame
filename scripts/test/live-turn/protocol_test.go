package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// Start the shipped executable, rather than a second test implementation of its server.
func fixture(t *testing.T, binary, certDir string) map[string]int {
	t.Helper()
	cmd := exec.Command(binary, "serve", "-user", "fixture", "-credential", "fixture-password", "-listen", "127.0.0.1", "-cert", filepath.Join(certDir, "cert.pem"), "-key", filepath.Join(certDir, "key.pem"))
	output, err := cmd.StdoutPipe()
	must(t, err)
	var errors bytes.Buffer
	cmd.Stderr = &errors
	must(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan map[string]int, 1)
	go func() {
		scanner := bufio.NewScanner(output)
		if !scanner.Scan() {
			ready <- nil
			return
		}
		var raw struct {
			UDP   int `json:"udp"`
			TCP   int `json:"tcp"`
			TLS   int `json:"tls"`
			Stats int `json:"stats"`
		}
		if json.Unmarshal(scanner.Bytes(), &raw) != nil {
			ready <- nil
			return
		}
		ready <- map[string]int{"udp": raw.UDP, "tcp": raw.TCP, "tls": raw.TLS, "stats": raw.Stats}
	}()
	select {
	case ports := <-ready:
		if ports == nil {
			t.Fatalf("fixture failed readiness: %s", errors.String())
		}
		return ports
	case <-time.After(10 * time.Second):
		t.Fatal("fixture readiness timeout")
		return nil
	}
}

func allocation(t *testing.T, transport string, ports map[string]int, certDir, password string) (net.PacketConn, error) {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", ports[transport])
	var conn net.PacketConn
	if transport == "udp" {
		var err error
		conn, err = net.ListenPacket("udp4", "127.0.0.1:0")
		must(t, err)
	} else {
		var stream net.Conn
		var err error
		if transport == "tls" {
			cert, err := os.ReadFile(filepath.Join(certDir, "cert.pem"))
			must(t, err)
			roots := x509.NewCertPool()
			if !roots.AppendCertsFromPEM(cert) {
				t.Fatal("invalid fixture certificate")
			}
			stream, err = tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp4", addr, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})
			must(t, err)
		} else {
			stream, err = net.DialTimeout("tcp4", addr, 5*time.Second)
			must(t, err)
		}
		conn = turn.NewSTUNConn(stream)
	}
	t.Cleanup(func() { _ = conn.Close() })
	client, err := turn.NewClient(&turn.ClientConfig{Conn: conn, STUNServerAddr: addr, TURNServerAddr: addr, Username: "fixture", Password: password, RTO: time.Millisecond * 100})
	must(t, err)
	t.Cleanup(client.Close)
	must(t, client.Listen())
	relay, err := client.Allocate()
	if err == nil {
		t.Cleanup(func() { _ = relay.Close() })
	}
	return relay, err
}

func serverCounts(t *testing.T, ports map[string]int) map[string]counts {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/stats", ports["stats"]))
	must(t, err)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stats status %d", response.StatusCode)
	}
	var seen map[string]counts
	must(t, json.NewDecoder(response.Body).Decode(&seen))
	return seen
}

func TestRealTURNRelayTransports(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "live-turn")
	build := exec.Command("go", "build", "-buildvcs=false", "-mod=readonly", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	if output, err := exec.Command(binary, "mint", directory).CombinedOutput(); err != nil {
		t.Fatalf("mint: %v %s", err, output)
	}
	for _, transport := range []string{"udp", "tcp", "tls"} {
		t.Run(transport, func(t *testing.T) {
			ports := fixture(t, binary, directory)
			first, err := allocation(t, transport, ports, directory, "fixture-password")
			must(t, err)
			second, err := allocation(t, transport, ports, directory, "fixture-password")
			must(t, err)
			// Both allocations establish real permissions, then transport bytes through the server.
			must(t, first.SetReadDeadline(time.Now().Add(5*time.Second)))
			must(t, second.SetReadDeadline(time.Now().Add(5*time.Second)))
			_, err = second.WriteTo([]byte("permission"), first.LocalAddr())
			must(t, err)
			_, err = first.WriteTo([]byte("authenticated relay payload"), second.LocalAddr())
			must(t, err)
			buffer := make([]byte, 256)
			n, _, err := second.ReadFrom(buffer)
			must(t, err)
			if string(buffer[:n]) != "authenticated relay payload" {
				t.Fatalf("incorrect relayed payload: %q", buffer[:n])
			}
			seen := serverCounts(t, ports)
			actual := seen[transport]
			if actual.AuthOK < 2 || actual.Allocations < 2 || actual.AuthFailed != 0 || actual.Bytes == 0 {
				t.Fatalf("missing real relay counters: %+v", actual)
			}
			if transport == "tls" && actual.Hellos < 2 {
				t.Fatalf("missing TLS handshakes: %+v", actual)
			}
			for name, other := range seen {
				if name != transport && (other.Packets+other.Conns+other.Bytes+other.Allocations) != 0 {
					t.Fatalf("unexpected %s traffic: %+v", name, other)
				}
			}
		})
	}
	t.Run("wrong-password-refused", func(t *testing.T) {
		ports := fixture(t, binary, directory)
		if _, err := allocation(t, "udp", ports, directory, "wrong-fixture-password"); err == nil {
			t.Fatal("wrong password allocated a relay")
		}
		actual := serverCounts(t, ports)["udp"]
		if actual.AuthFailed == 0 || actual.Allocations != 0 || actual.AuthOK != 0 {
			t.Fatalf("wrong password counters: %+v", actual)
		}
	})
}
