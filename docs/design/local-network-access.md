# Local Network Access

Status: implemented for fetch-based local transports.

The PWA is served from a public origin. Chrome's
[Local Network Access](https://wicg.github.io/local-network-access/) permission
gates requests from that origin to local or loopback destinations. The app
already used the first permission shape; this document records the current
spec and the parts the PWA implements.

## Permission names

The spec split the original `local-network-access` permission into:

| Destination | Permission |
|---|---|
| private IPv4/IPv6, link-local, `.local`, CGNAT/tailnet | `local-network` |
| loopback | `loopback-network` |

`local-network-access` remains an alias for compatibility. The host queries
the fine-grained name first and falls back to the alias, so an older Chromium
still answers. A browser that knows none reports `unsupported`, which means
the request proceeds as it did before LNA.

`packages/app-core/src/browser/host.ts` resolves the space; callers pass
`"local"` or `"loopback"` through `localNetworkPermission(space)`.

## Address spaces

`targetAddressSpaceFor` follows the spec table, not a guess from the hostname:

- `127.0.0.0/8`, `::1`, `::`, `0.0.0.0`, and `198.18.0.0/15` are loopback.
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
  `100.64.0.0/10`, `fc00::/7`, `fe80::/10`, `fec0::/10`, documentation
  prefixes, and `0.0.0.0/8` (except the null address itself) are local.
- `.local` and `.ts.net` names are annotated local.
- A hostname that resolves locally but carries neither a local literal nor
  `.local` needs an explicit `targetAddressSpace: "local"`; otherwise it is
  a public name and LNA does not exempt it from mixed content.
- IPv4-mapped IPv6 uses the embedded IPv4 address's space.

`localNetworkFetch` sets the hint and gives every request a hard timeout. The
timeout matters independently of LNA: a fetch paused on the prompt or a hung
local daemon must not freeze the pairing or sync UI.

## Callers

The helper is the egress path for:

- Tailnet vault drive reads and writes;
- browser pairing;
- CLI app-integration pairing;
- local plugin daemons;
- Nango/local directory reads;
- device identity;
- the vault relay;
- duress peer delivery, through its own request controller.

A direct `fetch` to a local or loopback destination is a bug unless it is the
same-origin app shell or a public API. WebSockets and WebTransport currently
have no `targetAddressSpace` option; the spec says they should be gated, but
Chromium has not shipped that integration yet. The plugin WebSocket path
therefore does not claim LNA support.

## Permission UX

The browser shows its own prompt. The app does not ask for the permission with
`Permissions.request` (there is no such request API for this feature in the
current spec); it reads `navigator.permissions.query` and lets the first real
request raise the prompt.

A pass nobody asked for must not raise the prompt. Tailnet sync therefore
checks the space before a timer/unlock pass and reports `blocked` with a
message. A person's own Sync now or pairing action may wait for the prompt.

## Deployment headers

`apps/pages/vercel.json` sends:

```text
Permissions-Policy: local-network=(self), loopback-network=(self), local-network-access=(self)
```

The default allowlist is already `self`; the explicit header prevents an
embedding page from accidentally removing the capability. GitHub Pages cannot
set custom response headers, so the static deployment relies on the default.

## Limits

- LNA is a secure-context feature. The production app uses HTTPS; a plain
  HTTP origin outside loopback cannot request it.
- The permission is origin-scoped, not vault-scoped.
- LNA protects the connection request, not the local service. Every local
  endpoint still needs its own authentication (operator token, slot key,
  pairing proof).
- A service worker's local requests are gated by the worker origin's prior
  grant; the app does not make local requests from the service worker.
- The app never treats a granted LNA permission as authority. It is a network
  gate, not an authorization decision.

## Acceptance

- `local-network` and `loopback-network` are queried separately, with the
  `local-network-access` alias as fallback.
- `0.0.0.0`, `198.18.0.0/15`, `::`, and `::1` classify as loopback.
- RFC1918, CGNAT, link-local, ULA, link-local IPv6 and documentation prefixes
  classify as local.
- IPv4-mapped IPv6 uses the embedded IPv4 space.
- Public names remain unannotated.
- A non-interactive tailnet pass does not raise the LNA prompt.
- CLI app-integration pairing uses the LNA helper.
