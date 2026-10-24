//go:build js && wasm

package main

import (
	"syscall/js"
	"testing"
)

func TestNativePeerTLSRejectsMalformedExplicitTrustWithoutFallback(t *testing.T) {
	for _, value := range []any{
		nil,
		true,
		"public",
		map[string]any{},
		map[string]any{"trustMode": "unknown"},
		map[string]any{"trustMode": "operator"},
		map[string]any{"trustMode": "operator", "operatorCAPEM": "invalid"},
		map[string]any{"trustMode": "public", "operatorCAPEM": ""},
		map[string]any{"trustMode": "public", "skipTLS": true},
	} {
		if roots, valid := nativePeerGETRoots(js.ValueOf(value)); valid || roots != nil {
			t.Fatal("Malformed explicit peer TLS trust silently adopted roots")
		}
	}
	for _, value := range []js.Value{js.Undefined(), js.ValueOf(map[string]any{"trustMode": "public"})} {
		if roots, valid := nativePeerGETRoots(value); !valid || roots == nil {
			t.Fatal("Pinned public trust must support omitted or explicit public mode")
		}
	}
}
