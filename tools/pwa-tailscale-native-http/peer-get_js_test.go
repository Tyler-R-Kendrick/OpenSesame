//go:build js && wasm

package nativehttp

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"syscall/js"
	"testing"
	"time"
)

func TestPeerGETRealGoJSBufferedAndDrainContract(t *testing.T) {
	var calls atomic.Int32
	factory := func(ctx context.Context, _ string) (*PeerGETRoute, error) {
		calls.Add(1)
		child, cancel := context.WithCancel(ctx)
		dial := func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != "100.64.0.1:80" {
				t.Error("Peer target changed")
			}
			client, server := net.Pipe()
			go func() {
				defer server.Close()
				request, err := http.ReadRequest(bufio.NewReader(server))
				if err != nil {
					return
				}
				request.Body.Close()
				io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npeer")
			}()
			return client, nil
		}
		return &PeerGETRoute{Context: child, Dial: dial, Current: func() bool { return child.Err() == nil }, Close: cancel}, nil
	}
	port, closePort, err := BindPeerGETJS(context.Background(), factory)
	if err != nil {
		t.Fatal(err)
	}
	defer closePort()
	token := js.Global().Get("Object").New()
	delivered := make(chan string, 1)
	publish := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 4 || !args[0].Equal(token) || args[1].Int() != 1 || args[3].String() != "" {
			delivered <- "invalid"
			return false
		}
		result := args[2]
		bytes := make([]byte, result.Get("body").Get("byteLength").Int())
		js.CopyBytesToGo(bytes, result.Get("body"))
		delivered <- string(bytes)
		return true
	})
	defer publish.Release()
	request := map[string]any{"method": "GET", "url": "http://100.64.0.1/proof", "headers": []any{}, "body": js.Global().Get("Uint8Array").New(0)}
	code := port["begin"].(js.Func).Invoke(1, request, token, publish).String()
	if code != "" {
		t.Fatal(code)
	}
	select {
	case value := <-delivered:
		if value != "peer" {
			t.Fatal("Real GoJS response changed")
		}
	case <-time.After(time.Second):
		t.Fatal("GoJS delivery did not settle")
	}
	drained := make(chan bool, 1)
	drainToken := js.Global().Get("Object").New()
	receipt := js.FuncOf(func(_ js.Value, args []js.Value) any {
		drained <- len(args) == 4 && args[0].Equal(drainToken) && args[1].Int() == 0 && args[3].String() == ""
		return true
	})
	defer receipt.Release()
	if port["drain"].(js.Func).Invoke(drainToken, receipt).String() != "" {
		t.Fatal("Drain refused")
	}
	select {
	case valid := <-drained:
		if !valid {
			t.Fatal("Drain receipt changed")
		}
	case <-time.After(time.Second):
		t.Fatal("Original GoJS drain did not settle")
	}
	if calls.Load() != 1 {
		t.Fatal("Peer request retried")
	}
}
func TestPeerGETGoJSRejectsSecretHeadersBeforeRouteCapture(t *testing.T) {
	var calls atomic.Int32
	factory := func(context.Context, string) (*PeerGETRoute, error) { calls.Add(1); return nil, errStopped }
	port, closePort, err := BindPeerGETJS(context.Background(), factory)
	if err != nil {
		t.Fatal(err)
	}
	defer closePort()
	token := js.Global().Get("Object").New()
	publish := js.FuncOf(func(js.Value, []js.Value) any { return false })
	defer publish.Release()
	request := map[string]any{"method": "GET", "url": "http://100.64.0.1/proof", "headers": []any{[]any{"Authorization", "secret"}}, "body": js.Global().Get("Uint8Array").New(0)}
	if port["begin"].(js.Func).Invoke(1, request, token, publish).String() != "input" || calls.Load() != 0 {
		t.Fatal("Header secret reached original route")
	}
}
