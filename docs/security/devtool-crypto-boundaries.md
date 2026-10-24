# Development tool crypto boundaries

The browser extension's WXT → web-ext-run → @devicefarmer/adbkit chain uses
the existing ADB server transport. It lists devices and uses shell, sync file
listing/upload, activity launch and port forwarding. It does not parse Android
public keys or create a TCP-to-USB bridge.

The pnpm adbkit patch defers exactly two imports until `parsePublicKey` or
`createTcpUsbBridge` is called. All transport implementations and the public
client factory, default binary, configured host/port and environment handling
remain upstream code. The `@devicefarmer/adbkit>node-forge` exclusion removes
crypto helpers outside this repository's development-tool scope. Those two
helpers fail to load without node-forge; this is intentional. The patch itself
preserves their upstream behavior when node-forge is installed.

The `promptfoo>jks-js` exclusion similarly disables optional Java KeyStore
conversion. It does not disable Node HTTPS PEM/PFX client certificates or the
Rust host's PKCS#12 support. This configuration is not a general-purpose
redistribution of every optional promptfoo or adbkit feature.

## Regression checks

Run `node --test scripts/security/adbkit-transport.test.mjs` after a frozen pnpm
install. The suite resolves adbkit through the extension's actual WXT and
web-ext-run dependencies, proves node-forge is absent, and exercises the real
installed library against a fragmented loopback ADB peer. It checks device
states, shell output, file LIST/SEND completion and errors, activity failure
and caller fallback, forward requests, and configured server-start binary
arguments. No Android device or external service is used.

Separately validate promptfoo CLI/config startup and loopback HTTPS PEM/PFX
requests after installation. The ADB peer test does not substitute for those
consumer checks or a physical Android smoke test.
