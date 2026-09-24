# ADR 0119 — Wallet-native surfaces are wired at the composition root, and refuse honestly until their owning swarm lands

Status: Accepted
Date: 2026-09-15
Amended: 2026-09-16
References:
ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0017 ([host/client product topology](0017-host-client-product-topology.md)),
ADR 0058 ([native authenticator and OpenID4VC wallet](0058-native-authenticator-and-openid4vc-wallet.md)),
ADR 0065 ([agent surface parity](0065-agent-surface-parity.md)),
ADR 0086 ([one interaction primitive](0086-wallet-native-interaction-layer.md)),
ADR 0090 ([static frontend complete without a backend](0090-static-frontend-complete-without-backend.md)),
ADR 0117 ([hosted SIOP ↔ OIDC bridge](0117-hosted-siop-oidc-bridge.md)),
[wallet interaction layer](../architecture/wallet-interaction-layer.md),
[protocol conformance](../reference/protocol-conformance.md)

## Context

ADR 0086 made one thing canonical: a cross-device question is an `Interaction`,
addressed by an opaque reference, and an approval counts only when a proof's
`boundDigest` equals the interaction's `requestDigest`. Around that primitive,
four wallet-native surfaces were planned, each backed by a pure library this
repository already carries and tests:

| Surface | Library | What it does |
|---------|---------|--------------|
| Wallet-pass registration | `@opensesame/wallet` | Issues a pass whose barcode is a canonical interaction URL (ADR 0086 §5). |
| OpenID4VP verifier | `@opensesame/openid4vp` | Asks a wallet for a presentation and verifies it (ADR 0086 §4). |
| OpenID4VCI issuer | `@opensesame/openid4vci` | Issues the minimal OpenSesame credential (ADR 0086 §7). |
| Cross-device rendezvous | `@opensesame/ceremony-kit` | Carries an opaque reference from one screen to another (ADR 0086 §3). |

The libraries are implemented. Their **HTTP mounts on the Identity API are
not** — they are being authored by separate work-streams, on their own
cadence. That left the composition root (`apps/control-plane/src/app.ts`,
`create-app.ts`) with a choice for each surface: leave the prefix unmounted, or
front it now.

An unmounted prefix answers `404`. A `404` is the wrong answer here for two
reasons. First, it is indistinguishable from "wrong path", so an integrator
cannot tell a surface that is *coming* from one that never existed — the
`SUPPORT_MATRIX` in each package says what the library does, but nothing at the
edge says whether it is reachable. Second, a half-finished mount that leaves one
verb or one subpath returning `404` while the rest of the surface works is a
silent hole, and the surface most dangerous to leave a hole in is one that
could be mistaken for having *settled an interaction* — the one thing ADR 0086
§4 says only `approve()` may do.

## Decision

### 0. Default mounts (2026-09-16 amendment)

`createControlPlane` now calls `resolveWalletNativeMounts` so that:

- `wallet.registration` and `rendezvous` are **always** mounted (registration
  still refuses Google issue when the vendor is unconfigured; rendezvous
  address admission refuses closed until an address registry is enabled).
- `openid4vp.verifier` mounts when `OPENSESAME_OID4VP_ENABLED` is true.
- `openid4vci.issuer` mounts when `OPENSESAME_OID4VCI_ENABLED` is true (ephemeral
  ES256 signing key for local/dev; durable production keys remain a deployment
  concern).
- Tests may pass `walletNative: {}` to keep every surface Unavailable.

Pages Settings › Security exposes **Add to Google Wallet** against
`/v1/wallet/registrations` when an Identity API is configured.

### 1. Every wallet-native prefix is wired at the composition root now

`apps/control-plane/src/routes/wallet-native.ts` owns the four prefixes
(`/v1/wallet`, `/v1/openid4vp`, `/v1/openid4vci`, `/v1/rendezvous`).
`mountWalletNativeRoutes(app, mounts)` is called once from `createHonoApp`,
alongside — never instead of — the SIOP link routes of ADR 0117. The prefixes
exist on every deployment from the first boot, so an integrator can probe them
and the honest answer is at the edge, not only in a package constant.

### 2. Absent a real router, a surface is a typed Unavailable stub

For any surface whose owning swarm has not yet supplied a router, the mount is a
stub that answers **`501 Not Implemented`** on every method and every subpath
under the prefix, with a machine-readable body:

```json
{
  "error": "capability_unavailable",
  "capability": "openid4vp.verifier",
  "reason": "the OpenID4VP verifier is not mounted; a verified presentation must bind to an interaction digest, never settle one directly (ADR 0086 §4)",
  "adr": "0119-wallet-native-control-plane-composition.md",
  "correlationId": "…"
}
```

The wildcard is the point: there is no corner of an unmounted surface that
answers anything but the refusal, so a partially-wired surface cannot leave a
working hole, and "not built yet" and "you have the path wrong" are one answer
at one shape. This mirrors `docs/reference/protocol-conformance.md`'s house style — a
typed refusal is worth more than a happy path that cannot run.

### 3. The runtime support matrix is served, not only documented

`GET /v1/wallet-native/capabilities` returns the same inventory the stubs are
built from: each surface's id, its mount path, the library behind it, the ADR,
and whether it is `available` or `unavailable` (with the reason, when it is).
It is public and carries no secret and no tenant data — the same posture as the
federated provider catalog (ADR 0055 / C8). `walletNativeCapabilities(mounts)`
computes it from what was actually wired, so the matrix cannot drift from the
mounts: a surface reads `available` **only** when a real router was supplied.

### 4. A real router plugs into the seam; it never settles an interaction

`CreateControlPlaneOptions.walletNative` and the `mounts` argument of
`mountWalletNativeRoutes` are the seam. When a swarm lands `create<surface>Routes()`,
it is wired by passing it in from `app.ts`:

```ts
mountWalletNativeRoutes(app, { openid4vpVerifier: createOpenid4vpRoutes() });
```

A supplied router replaces the stub for that surface and the matrix flips it to
`available` — with no other edit to the composition root. The binding contract
is load-bearing and stated here so a later author cannot miss it: a verifier, an
issuer, a pass provider or a rendezvous mount **routes its result back through
the interaction layer** and may not approve, settle or authorize anything on its
own. The verifier hands a `VerifiedPresentation` to `approve()` and lets the
digest check decide; it does not decide. This is the same invariant ADR 0086 §4
states, read from the composition root: the four surfaces are ways to *reach* an
interaction, never a second authority beside it. The agent-surface half of that
same fence is `packages/capability-registry`'s `assertsNoInteractionSettlementTool`
— no tool name may claim to settle one (ADR 0065).

### 5. Nothing here points at a local host, and nothing gates on "a backend"

Consistent with ADR 0090: the wallet-native prefixes are Identity-plane routes
with no default pointing at a loopback address, and a surface that is
unavailable says exactly that — it never names a service that is not there.

## Consequences

**The matrix is the truth.** Because `walletNativeCapabilities` reads the same
`mounts` the router uses, a surface cannot report `available` while answering
`501`, and cannot report `unavailable` while a real router is mounted. A test
asserts both directions.

**Swapping in a real surface is a one-line change.** The owning swarm authors
its router in its own file and adds one key to the `walletNative` mounts. The
composition root, the stub, the matrix and the ADR need no edit — the stub
simply stops being reached.

**A `501` is not a `404` and not a `200`.** Integrators and conformance tooling
can tell "planned but unmounted" from "no such route" and from "working". A
scanner that treats non-`200` as absent still behaves correctly; one that reads
the body learns why.

**This does not implement any surface.** It is composition and refusal only. It
does not verify a presentation, issue a credential, mint a pass, or open a
rendezvous — each of those lands with its owning swarm's router, and until then
the honest answer is the one at the edge.

**SIOP is untouched.** The hosted SIOP link routes of ADR 0117 keep their mount
and their principal gate; the wallet-native mounts are strictly additive.
