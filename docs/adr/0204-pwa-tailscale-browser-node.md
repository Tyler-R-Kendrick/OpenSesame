# ADR 0204: Run the official Tailscale browser node in an isolated Worker

Status: Accepted

The PWA needs a real Tailscale connection without an application backend,
proxy, browser extension or access to a host process. Management REST endpoints
and browser node enrollment are separate protocols. Hosted management CORS
restrictions must not prevent use of Tailscale's supported browser control plane.

Use the official `@tailscale/connect` client, pinned to
`1.102.3-3-tb31d8a75a-g5e651e16f`. Its WebAssembly contains the actual Go
control client, userspace network stack, WireGuard and DERP client. A dedicated
Worker joins through the control server's Noise WebSocket protocol. Interactive
login is the primary hosted path; a person may instead supply an auth key.
A node is connected only after both `Running` and a `MachineAuthorized` netmap.

The package eagerly initializes a DOM terminal, although its Go runtime is a
self-contained top-level IIFE. The build verifies the package JavaScript digest,
uses the TypeScript AST to select exactly that intact statement, verifies its
own digest and emits it unchanged. The official compressed WASM is also verified
before emission, including the actual decompressed artifact digest. This avoids
shipping terminal code or modifying SDK semantics. Both upstream BSD licenses
ship beside the runtime. The package's build-info raw hash is distinct from its
postprocessed published WASM; the actual published bytes are the build contract.

The optional Networking capability owns the Worker, 8 KB Go runtime and
6.6 MB gzip WASM. The artifact manifest is the single source for hashes and
filenames. The existing capability graph and service worker admission govern
caching. Hardened distributions that exclude Networking contain none of these
assets. Loading the optional client needs no CDN.

The Worker privately wraps HTTP and WebSocket construction. Each external
request waits for the owning capability's captured egress decision. WebSocket
URLs are normalized only for policy classification; the real connection keeps
its original protocol. No main-document globals are changed. Diagnostic log
uploads are refused and the private Go logger does not print node identities.
Lock, cancellation, capability disposal and changed credential bytes terminate
the Worker and invalidate pending requests.

SDK private state lives in an actual Token CredentialItem in the person's
unlocked vault. Public connection metadata holds a target-bound item reference.
State writes use the vault's queued, exact-prior-item, cross-tab conflict guard;
network decisions and connected status wait for those writes. Node state never
uses localStorage or sessionStorage. Disconnect preserves encrypted state for
reconnection; forgetting it removes local configuration and retires the token.
It does not claim to revoke the remote node.

The published SDK exposes HTTP GET without custom headers. Its Go HTTP client
follows peer redirects internally; tailnet routes and grants govern them. The
PWA checks the initial peer URL and each outer control/relay request, and does
not claim to intercept each redirect inside the encrypted stack. Peer text is
limited to one million UTF-16 code units after the SDK materializes it; this SDK does not expose a
streaming body limit. A 30-second GET timeout terminates the Worker to cancel
the underlying operation. The PWA therefore
exposes GET and a tailnet-service probe, and does not claim this client performs
the existing authenticated vault-drive GET/PUT sync protocol. Extending that
surface requires a separately reviewed upstream change or a reproducible build
of reviewed source.

OAuth app registration remains a distinct, narrowly scoped management flow.
The PWA generates a deployment-specific public registration artifact, while
Tailscale issues the actual client ID and secret. Where the configured endpoint
admits browser CORS, the PWA can create and verify the app, open fresh user
consent and exchange its code for the single-use one-hour device auth key.
Otherwise the person may import the actual vendor response; pasted credentials
are unverified. No fictional console import or CORS bypass is introduced.
Optional `allowedNodeAttributes` must have the vendor's `custom:` prefix and
match the configured set exactly. These apply to OAuth-provisioned devices;
ordinary interactive browser enrollment does not assert those attributes.

Evidence separates genuine upstream behavior from test boundaries: the official
WASM reached an actual hosted login URL through `/key` and `/ts2021`; a real
Headscale control plane, embedded DERP and official userspace native peer proved
node authorization and peer GET without a TUN. Fixture DNS and certificate trust
are test-only. These observations do not claim access to a user's hosted tenant
or that a management fixture proves hosted REST CORS support.

## Measured shipped cost

Frozen production `7bd502e7` has an independently clean ownership/reachability
graph and measures 7,103 KiB of JavaScript and 2,142 KiB gzip. The final backup
parent measured 6,979/2,109 KiB; AI and Tailscale together add 124/33 KiB. The
previous recorded AI phase measured 7,007/2,118 KiB. The bootstrap's static
closure grows by only 245 raw bytes and 54 gzip bytes over the backup parent;
the optional client, forms and inference implementations load on explicit use.

Set only the default JavaScript ceilings to 7,140/2,156 KiB, leaving 37/14 KiB
of measured headroom. Total output is 16,582 KiB, CSS is 180 KiB and the largest
asset is the official 6,600,192-byte compressed WASM (6,446 KiB), all within
their existing ceilings. The raw WASM and terminal bundle are absent. Hardened
profiles must omit the Networking runtime and all three Tailscale public assets;
their ceilings, and every structural ceiling, remain unchanged. Final profile
builds and installed-PWA cache checks are recorded separately before readiness.

## Amendment 2026-10-24 — the Worker trusts one transferred port

The Worker object is reachable from code on the page.
`tailscaleBrowserNode()` returns the controller, whose TypeScript-private
`worker` is an ordinary property, and `Worker.prototype.postMessage` can be
wrapped. Its own message channel therefore grants nothing.

- **One port per start.** Each `start` creates a `MessageChannel` and
  transfers one port with the `start` message. The worker binds the single
  port of its first `start`. A later `start`, or one carrying no port or
  several, starts nothing.
- **Grants and decisions travel only on that port.** A peer GET is posted
  there only after the egress policy approved that exact URL. An egress
  decision reply names the URL and method it decided, and the worker settles
  a pending request only with a reply for that same request.
- **Everything else after `start` rides it too**, in both directions:
  `login`, the native HTTP and close commands, and every message the worker
  sends. That includes the `closeHTTP` acknowledgement retirement waits for:
  a node that made a peer request is terminated once its worker acknowledges
  on the port, or after 60 seconds, and a replacement `start` is refused
  unless that acknowledgement confirmed the peer transport closed.
- **Nothing on the Worker channel is trusted.** The worker acts on nothing
  but `start` posted to the Worker. The controller sets no message handler on
  the Worker, so a message posted or dispatched there reaches nothing. The
  Worker's `error` event only stops the node, which `stop()` already permits.
- **The page's end of the port stays private.** It is kept only in `#private`
  fields, beside `assertCurrent`, `approve` and `approvePeer`, which are bound
  when the controller is created, before the node is published.
- **No reachable object holds a sender over the port.** Every member of the
  controller and of `BrowserNodeRequests` that touches the port, the pending
  requests or the host messages is `#private`, so at run time the controller
  shows only the `TailscaleBrowserNode` methods. A native stream holds a frozen
  channel that sends only its own `nativeHTTPStream`, `pullHTTP` and
  `cancelHTTP`; the worker refuses a reused id, a pull out of sequence and a
  command for a stream it does not hold.

Residual risk: script that runs on this origin before the node starts can
wrap `Worker`, `MessageChannel` or `MessagePort` and stand between the two.
No check in the page can see that. The deployment bounds it:

- the PWA's Content-Security-Policy (`script-src 'self' 'wasm-unsafe-eval'`)
  admits no inline or third-party script;
- the origin serves no other script;
- on the shared `github.io` origin, every other Pages site of the same
  account is same-origin, and a dedicated origin removes that.

Audits: `docs/security/audits/2026-10-24-tailnet-worker-peer-get.md`, and the
follow-up `docs/security/audits/2026-10-24-tailnet-worker-port-reland.md`.

References:

- [Official AI guidance](https://tailscale.com/docs/develop-with-ai)
- [Official Tailscale skill](https://tailscale.com/docs/features/tailscale-skill)
- [Browser SDK source](https://github.com/tailscale/tailscale/tree/main/cmd/tsconnect)
- [Tailcat browser transport](https://github.com/tailscale/tailcat)
- [Provisioned node attributes](https://tailscale.com/docs/reference/tailscale-api#node-attributes-for-provisioned-devices)
- [Trust credentials](https://tailscale.com/docs/reference/trust-credentials)
