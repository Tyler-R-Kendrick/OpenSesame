# Isolated Web App target

Status: build target and runtime gate implemented; Direct Sockets adapter added.

The PWA and the Isolated Web App share the same source tree and capability
composition. They differ in packaging and in what the browser permits:

| | PWA | IWA |
|---|---|---|
| Origin | `https://…` | `isolated-app://<bundle-id>` |
| Delivery | static host + service worker | signed `.swbn` bundle |
| Update | HTTP deploy | Web App Update Manifest |
| Local network | fetch + Local Network Access | fetch + LNA, or Direct Sockets |
| Raw TCP/UDP | unavailable | Direct Sockets |
| Service worker | registered | not registered |
| Manifest | linked web manifest | `.well-known/manifest.webmanifest` in the bundle |

## Build

```bash
pnpm --filter @opensesame/pages run build:iwa
```

The build uses `VITE_BASE=/`, the `isolated_web_app` deployment profile, and
writes `dist-iwa/.well-known/manifest.webmanifest`. The `version` field comes
from the package version or `IWA_VERSION`; an update must raise it.

Signing is a separate step because the key must not be in the repository:

```bash
IWA_SIGNING_KEY=/secure/private_key.pem \
WEB_BUNDLE_SIGNING_PASSPHRASE='…' \
pnpm --filter @opensesame/pages run build:iwa:signed
```

`wbn` and `wbn-sign` are pinned dev dependencies. The result is
`dist-iwa/opensesame.swbn`; installing it requires the IWA dev flag and
`chrome://web-app-internals` (or an enterprise IWA policy).

## Manifest and permissions

The generated manifest declares:

```json
"permissions_policy": {
  "direct-sockets": ["self"],
  "direct-sockets-multicast": ["self"],
  "direct-sockets-private": ["self"],
  "cross-origin-isolated": ["self"]
}
```

`permissions_policy` only makes the capability requestable; it does not grant
it. IWAs still enforce their own CSP, cross-origin isolation, and the
`isolated-app` origin. The build suppresses the public SIOP metadata document:
an isolated origin has no public HTTPS issuer.

## Runtime

`EnvironmentPort.runtime` reports `iwa` for an `isolated-app` document. The
shell skips service-worker registration in that mode: an IWA is already a
signed, locally bundled app, and a second network-shaped update path would
contradict the packaging model.

`packages/app-core/src/lib/direct-sockets.ts` wraps `TCPSocket`,
`TCPServerSocket` and `UDPSocket` with bounded construction helpers. It is
available only in an IWA and is intended for:

- local SSH/RDP/Telnet/terminal transports;
- printers and IoT devices;
- mDNS/DNS-SD multicast discovery;
- local listeners for device pairing.

It is not a grant: each caller must still enforce capability, destination,
user intent, and a timeout. The adapter never decides whether a socket is
allowed.

The existing PWA paths stay authoritative: fetch + Local Network Access for
HTTP, WebSocket/WebTransport where available, and the native daemon for work a
browser cannot do. Tailscale remains the default encrypted vault-drive
transport; IWA Direct Sockets are an additional local capability, not a
replacement for Tailscale identity or transport.

## Limits

- IWA installation is Chrome/ChromeOS/enterprise gated and requires signing.
- Direct Sockets are not available to ordinary HTTPS pages, including the PWA.
- A raw socket does not provide TLS. SSH, TLS-wrapped KMIP, or custom
  protocols need their own protocol implementation and certificate validation.
- The IWA CSP still forbids inline script, remote script, and arbitrary
  `object`/`embed`; the shared app must keep its no-inline production policy.
- The signed bundle must contain every runtime asset; a build that fetches a
  missing module from the network is not an IWA.
- No service worker registration, push subscription, or HTTP cache update path
  is used in this target.

## Acceptance

- `build:iwa` emits a bundle with `.well-known/manifest.webmanifest` and a
  numeric `version`.
- The IWA profile resolves only for `isolated-app://` origins.
- An IWA document reports `runtime === "iwa"` and does not register a service
  worker.
- The PWA build is unchanged.
- The Direct Sockets adapter refuses non-IWA contexts and invalid ports.
- An IWA manifest carries the Direct Sockets permissions but no secret.
