# ADR 0132 — Optional mTLS and workload identity

Status: Accepted
Date: 2026-09-22
Supplements: ADR 0005 (authority handles), ADR 0017 (host/client topology),
ADR 0042 (NATS TaskBus and auth callout), ADR 0048 §5 (daemon dependency
budget), ADR 0075 (host certificate key custody), ADR 0090 / ADR 0128 (Pages
is complete without a backend)
Operator reference: [docs/operators/mtls.md](../operators/mtls.md)
Threat model: [docs/security/mtls-threat-model.md](../security/mtls-threat-model.md)
Evidence: [docs/validation/mtls-implementation.md](../validation/mtls-implementation.md)

## Context

Before this decision, every networked hop between OpenSesame's own services
authenticated with a shared string, or not at all:

- The Host gateway bound one `tokio::net::TcpListener` and served every route
  in plaintext (`apps/gateway/src/main.rs`). Nothing in the process configured
  client-certificate verification.
- The NATS auth-callout route (`POST /api/v1/nats/auth/callout`) authenticated
  its bridge with `OPENSESAME_NATS_CALLOUT_SECRET` and then trusted the
  `issuer`/`subject` the bridge wrote into JSON. The bridge was an HTTP client;
  the native `$SYS.REQ.USER.AUTH` protocol was not implemented.
- Host → Identity mapping resolution carried `OPENSESAME_MAPPING_RESOLVE_TOKEN`
  as a bearer (`apps/gateway/src/identity_mapping.rs`), and Identity's
  `assertSecureConfig` required that token to exist whatever the transport.
- The task bus dialed `async_nats::connect(url)` with no identity, no required
  TLS, and no server-identity policy (`crates/task-bus/src/nats.rs`).
- The worker accepted `OPENSESAME_WORKER_TOKEN` and fell back to
  `OPENSESAME_OPERATOR_TOKEN` (`apps/worker/src/main.rs`).
- `crates/provider-static-mesh` called itself a "static mTLS mesh adapter". It
  is a service-discovery map behind a mutex, and it has never opened a socket.
- `docs/reference/standards-matrix.md` listed RFC 8705 as "where supported / mesh/gateway"
  with no implementation, and RFC 7030 EST as served from
  `apps/gateway/src/routes/est_server.rs`, a file that does not exist.

None of that is wrong for a single-host deployment on loopback and Unix
sockets, which `crates/uds-authn` and the daemon's operator-token fence already
protect. It is wrong the moment two of these services sit on different
machines: a copied string is then the only thing standing between a network
position and Host authority.

The constraint that shapes everything below is that `apps/pages` is a static
front end (ADR 0090, ADR 0128). A browser cannot attach a vault key to
`fetch`'s TLS handshake, select a certificate through a web API, or install
OS trust; `credentials: "include"` is not certificate provisioning; WebAssembly
and service workers do not change that. Whatever transport security the native
planes gain, the PWA must keep booting, unlocking and running its local
journeys from static files with no Host, Identity, NATS, OpenBao, SPIRE,
daemon, extension, environment variable or remotely trusted CA.

## Decision

### 1. Transport policy is a closed enum, and none of its values is a fallback

Every listener and every native client names exactly one policy from
`opensesame_domain::transport::TransportPolicy`:

| Policy | Meaning |
|---|---|
| `existing_local` | The loopback / UDS / operator-token profile that already exists. It is a supported profile in its own right, never the place a failed remote profile lands. |
| `server_tls` | Server-authenticated TLS with the existing application authentication on top. Not advertised as mTLS. |
| `mtls_required` | The handshake must authenticate a client certificate against the listener's trust profile; the peer must then resolve to exactly one service binding; the operation must then pass ordinary authorization. Any of the three failing is a denial. |
| `trusted_ingress` | Like `mtls_required` for the immediate peer, plus acceptance of RFC 9440 originating-client fields — only from a peer bound with purpose `trusted_ingress`, only on the listener declared for it. |

A configured `mtls_required` service whose material is missing, mismatched,
expired or untrusted does not start (Host: `main` returns `Err`; worker exits;
Identity: `assertSecureConfig` throws). It does not downgrade to bearer-only,
plaintext, the memory bus, a different issuer or a shared operator
certificate. `PolicyDowngradeRefused` and `EnforcementUnsupported` are error
codes, not log lines.

### 2. Identity sources and where their private keys live

An identity source produces a usable TLS identity — a chain *and* a key — or it
is not a source. Public certificate bytes alone are metadata.

| `IdentitySourceKind` | `Custody` | What that custody actually is |
|---|---|---|
| `pem_files` | `native_file_exportable` | A certificate and key file the deployment plane placed on disk. Readable by anything with the file permission. |
| `managed_certificate` | `host_sealed_exportable_to_host` | An ADR 0075 managed leaf. The key is sealed under `managed_leaf_key` and opened **by the Host process** for its own listener or client. It is exportable to that process by construction, and revealable to an owner/admin/operator through the ADR 0075 route. It is not hardware-bound and this ADR does not call it so. |
| `spiffe_workload_api` | `workload_api_delivered` | An X.509-SVID fetched from a SPIFFE Workload API socket by `crates/spiffe-source`. The Workload API delivers the private key to the workload; every process that can reach the socket under the same attestation receives the same material. Siblings sharing a socket are not isolated from one another. |
| `browser_managed` | `browser_external` | A certificate the browser or OS holds and presents on its own. OpenSesame neither provisions nor selects it, and the PWA cannot observe whether it was sent. |

SPIFFE X.509-SVID is the interoperable workload profile; a locally configured
private PKI is the other supported profile. SPIRE is an optional issuer that a
deployment may point the source at. It is not a baseline dependency, and no
default configuration assumes it.

The vault's keys never become a transport identity. A browser-only invocation
that would need one receives `browser_vault_key_injection = unsupported` from
`TransportCapabilities`, and nothing exports, proxies or re-homes the key to
satisfy it (ADR 0005, ADR 0075).

### 3. The chain we present and the bundle we trust are different objects

`TlsIdentity` (ours) and `TrustBundle` (theirs) are separate types with
separate generations. A trust profile is one of `webpki_dns`, `private_root`
or `spiffe_trust_domain`:

- `webpki_dns` validates a reference identity per RFC 9525 — lowercase DNS
  name, exact match, no wildcard on the peer selector side.
- `private_root` validates against an operator-installed bundle and then
  requires an exact `PeerIdentitySelector` match. "Any certificate under this
  root" is never a service authorization.
- `spiffe_trust_domain` builds the chain against the bundle of the trust
  domain the SVID names, then requires the exact SPIFFE ID. There is no union
  of all known domains into one store; a bundle offered for a different
  domain's SVID is `TrustUnknown`.

Server-name checking is never disabled to make SPIFFE work. The SPIFFE
verifier still validates the chain and the TLS signatures through rustls; it
replaces the DNS reference identity with a URI-SAN reference identity.

Trust roots are installed by an administrator through
`PUT /api/v1/operator/transport/trust`, audited, and rolled with an explicit
overlap window. No root is imported because a certificate, CSR, URL or
manifest suggested it.

### 4. Verified evidence is a private type; DTOs are separate

`VerifiedPeer` has no `Deserialize` impl and private fields. The one
constructor is `attest::AttestedPeer::into_verified`, and its callers are
enumerable: the rustls verifier in `crates/transport-security`, the Node
`tls.TLSSocket` adapter in `apps/control-plane/src/transport`, and the UDS
peer-credential adapter. Nothing that reads a header, a query string, a JSON
body or a plugin manifest can produce one. A client that writes
`"verified": true` has written a string.

What the evidence carries: the immediate peer's validated selectors and leaf
SHA-256 thumbprint, its validity window, the trust profile and generation it
was checked under, the credential generation, listener id, policy, TLS
version, the time of authentication and a `usable_until` bound. For
`trusted_ingress_assertion` evidence it also carries the ingress's own
`VerifiedPeer`, so the originating client and the proxy are never confused
for one another. It carries no role, tenant or principal — those are resolved
afterwards from bindings and grants, and are not "verified transport" facts.

`PeerEvidenceView` is the public shape. It omits the subject DN and every
path, socket and key.

### 5. Service bindings: default deny, exact identity, no name join

A binding is `(trust profile, exact peer selector, purpose) → service
principal`, with `allowed_operations`, `allowed_audiences`, a scope
(`deployment` or one organization), a revision, `enabled`, `revoked`,
`not_after` and `denied_thumbprints`. `ServiceBindingSet::resolve` returns the
single enabled, unrevoked, in-window binding whose profile, selector and
purpose all match: zero matches is `PeerNotBound`, more than one is
`AmbiguousBinding`, a thumbprint in `denied_thumbprints` is
`EvidenceRevoked` even when the name selector still matches.

Selectors are `spiffe_id`, `dns_name`, `uri_san` or `leaf_thumbprint_sha256`,
exact-match only. There is no CN, email, IP, wildcard, subject-DN or
"any under root" selector, and nothing joins a certificate to a human by name
or address (ADR 0042 §3 stands). There is no fleet-wide role: a binding
authorizes one service principal for the operations it lists, and a bridge
with a valid binding does not thereby hold operator authority.

Binding sets are stored under the Host's `host_kv` key
`transport.service_bindings`, may be overridden by
`OPENSESAME_SERVICE_BINDINGS_FILE` (visibly, in status), and change only
through the configurator-gated `PUT /api/v1/operator/transport/bindings` with
compare-and-set on `revision`. Tenants cannot edit deployment admission by
editing a connection.

### 6. Effective authority is an intersection

For a service-only operation (`nats.callout.decide`, `worker.providers.list`,
`worker.health.ready`, `principals.mapping.resolve`, `ingress.forward`,
`transport.probe`) the caller is the bound service principal and no human
session is required. For an operation performed on behalf of a person or an
agent (`connector.invoke`), the actor and delegation chain are resolved
separately and stay separate.

In both cases the authority actually exercised is the intersection of:
transport admission (§1) ∩ service binding (§5) ∩ the current caller or
delegation grant ∩ resource/tenant policy ∩ any proof-of-possession the token
demands. Each check is re-run per protected operation; a long-lived
connection does not cache the result past `usable_until`, a changed binding
revision or a changed trust/credential generation. Admission is never a
substitute for `resolve_caller`, an existing PEP, or ConnectionRef
authorization.

### 7. The threat this design is shaped around is credential substitution

The attack is not a forged certificate. It is a *legitimate* certificate
combined with somebody else's other factor: tenant B's leaf presented with
tenant A's bearer token, ConnectionRef, NATS user claim, pooled client or
forwarded header. Independently valid factors, accidentally unioned, are a
privilege escalation.

The rule is that factors combine under an explicit binding policy or not at
all:

- An RFC 8705 certificate-bound token carries `cnf.x5t#S256`; the resource
  compares it with the thumbprint of the **originating** authenticated leaf —
  never the ingress's leaf, never a JWK thumbprint, never a value from the
  request. A different certificate over the same public key is a mismatch.
- A callout decision is bound to the normalized request digest, the server
  context, the one-time user NKey and the authenticated bridge; a retry can
  reproduce the same still-valid decision and nothing else.
- Native client pools are keyed by execution identity, tenant, connection,
  destination authority, credential generation, trust generation and
  protocol policy. A new generation never reuses a connection authenticated
  under the old key.
- Originating-client evidence is attached to the request that carried it, not
  to the ingress connection it arrived on.

### 8. Consumers

Every adapter has a production call site or it does not exist. The consumers
this ADR ships, and where each one enforces:

| Hop | Client side | Server side | Legacy profile kept |
|---|---|---|---|
| Host secure listener | — | `SecureListener` on `OPENSESAME_TLS_LISTEN`, same router, provenance `host-tls`; plain listener keeps `host-plain` | plain listener with UDS/operator-token routes |
| Worker | Whatever operator-configured service holds a `worker_client` binding; no in-tree consumer dials the worker at this baseline, and none is invented | `OPENSESAME_WORKER_TRANSPORT=mtls_required` with `OPENSESAME_WORKER_TLS_*` and `OPENSESAME_WORKER_BINDINGS_FILE`; no operator-token substitution in that profile | `existing_local`: loopback + worker token |
| Host → Identity mapping | `OPENSESAME_MAPPING_TLS_*` inside the same egress fences (HTTPS-or-loopback, no proxy, no redirect, DNS-pinned, 8 KiB cap) | Identity `OPENSESAME_MAPPING_AUTH=mtls` admits only `principals.mapping.resolve` | `OPENSESAME_MAPPING_AUTH=shared_secret` (bearer) |
| NATS client | `OPENSESAME_NATS_TLS_*`, `OPENSESAME_NATS_REQUIRE_TLS=1`, `OPENSESAME_NATS_TLS_FIRST=1`, `OPENSESAME_NATS_AUTH` (nkey/creds) | the server's own `tls { verify: true }` (profile A) or `verify_and_map: true` (profile B); `ops/nats/` | `OPENSESAME_TASKBUS=memory`, or plaintext NATS on loopback |
| NATS auth callout | `opensesame-nats-auth-bridge` answers native `$SYS.REQ.USER.AUTH`, then calls Host with `OPENSESAME_CALLOUT_TLS_*` | Host binding with purpose `nats_auth_bridge`; the user's upstream token is verified by Host, not trusted from the bridge | `OPENSESAME_NATS_CALLOUT_AUTH=shared_secret` on `existing_local` only |
| Upstream connectors | `crates/connection-broker` transport refs + `crates/invoke-through` TLS client injection; OpenBao `auth/cert` in `crates/provider-openbao` | the upstream's own policy | token / AppRole modes stay explicit modes |
| Trusted ingress | Caddy reference in `ops/ingress/` terminates browser mTLS and forwards `Client-Cert` / `Client-Cert-Chain` | Host/Identity `trusted_ingress` listener, `OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`, binding purpose `trusted_ingress` | direct `mtls_required` is a distinct profile |
| Identity listener | — | Node `tls.createServer` profile covering **both** the raw `provider.callback()` dispatch and the Hono routes; evidence attached from the socket, never from a header or a replayed body | plain HTTP on loopback |

The auth-callout bridge remains a high-trust component. It is authenticated,
narrowly bound and unable to launder unsigned end-user claims; it is not
called compromise-resistant.

### 9. Status has five dimensions, and enforcement is proved by a negative

`TransportStatusView` reports, separately: the desired policy; credential
availability and custody; runtime installation (`not_loaded`, `loaded`,
`reload_failed`); the last observed peer authentication; and enforcement
coverage. These are not collapsed into a traffic light.

`EnforcementStatus` becomes `verified` only through
`POST /api/v1/operator/transport/verify`: a harmless `GET /health/live`
against the named target **with** the configured certificate and **without**
one, recorded with the generation it ran under and a `fresh_until`. A
successful connection with a certificate proves the server accepted it, not
that it rejects callers without one. When the trust, credential or listener
generation moves, prior evidence becomes `stale` rather than certifying the
new configuration. A browser session, a settings toggle or a stored flag
cannot self-certify enforcement.

### 10. Resumption and early data are off on privileged profiles

`mtls_required` and `trusted_ingress` server profiles disable session tickets,
server session storage, 0-RTT (`max_early_data_size = 0`) and half-RTT data.
This is a product choice: a resumed connection must not outlive the policy it
was admitted under, and no sensitive operation may execute from replayable
data. It is not a claim that TLS resumption is inherently unsafe, and a later
decision may enable it for a profile once identity retention, expiry,
revocation and replay tests prove it. TLS 1.3 is the default; TLS 1.2 is
available only by explicit `*_MIN_VERSION=1.2` with rustls's safe defaults;
nothing older is offered.

### 11. Revocation has a bound per layer, and none of them is instant

| Layer | What is enforced | Bound |
|---|---|---|
| New handshakes | Current trust generation, CRL (if `*_CRL_FILE` is set), `denied_thumbprints` | Next connection |
| Existing native HTTP connections | Per-request recheck of binding revision, generation, `denied_thumbprints` and `usable_until` | The next protected request; at most `ListenerLimits.usable_for` |
| NATS sessions | Server-side authorization expiry from the callout response; the server disconnects | The expiry the callout issued; a cooperative client timer is not relied on |
| OpenBao tokens | Independent token TTL and explicit revoke | The token's own lifetime; a transport revocation does not revoke it |
| OAuth tokens | Token lifetime and RFC 7009 revocation; a rotated certificate does not inherit the old token's `cnf` | The token's own lifetime |
| Browser cache and local vault | Nothing remote | Cached application code still runs; local unlock is governed by local protection only |

A transport revocation therefore promises: no new admission after the next
handshake, and no further protected operation on an existing connection after
the next recheck. It does not promise that a fleet stops instantly, that a
minted token dies, or that anything is erased from a browser.

### 12. Rotation activates whole generations atomically

A candidate generation is key + chain + trust bundles, validated together
(key matches leaf, chain builds to the profile's anchors, leaf not expired at
load) before `TransportGenerations::activate` swaps it. A malformed candidate
leaves the previous generation in place only inside that generation's own
validity; it cannot extend an expiry or resurrect a withdrawn credential. A
Workload API snapshot replaces the previous state whole: an SVID or bundle the
new snapshot omits stops authorizing at once, and a source outage keeps the
last valid generation only until its own `not_after` or the configured
freshness bound, whichever is sooner. Managed-leaf renewal keeps ADR 0075's
half-lifetime lead clamp; SPIFFE sources are not run through that renewal
loop.

### 13. Dependency boundaries that must not move

- `apps/daemon` stays at serde + serde_json + thiserror + std
  (`scripts/daemon-deps-gate.sh`, ADR 0048 §5). No TLS, gRPC or SPIFFE
  dependency is added to it for symmetry, and its operator mint/forwarding
  path is not exposed remotely.
- Browser packages (`apps/pages`, `packages/os-domain`, `packages/contracts`,
  `packages/capability-registry`) carry the pure TypeScript mirror of the
  contracts and no `node:tls`, `node:fs`, socket or Workload API code.
- Credential material has no slot in browser runtime configuration. Native
  file paths, sockets and trust files exist only as `OPENSESAME_*` deployment
  environment, never in a tenant-level form or an API body.

### 14. What is deliberately not built or not claimed

- **No EST or ACME enrollment server.** `apps/gateway/src/routes/est_server.rs`
  and `acme_server.rs` do not exist at this baseline; RFC 7030 is classified
  absent in the standards matrix and is not a prerequisite of anything here.
  Issuance uses the implemented ADR 0075 managed path or an external SPIFFE
  issuer.
- **No browser vault-key injection**, no `fetch({cert, key})`, no silent
  proxy, no native-helper fallback.
- **No per-subagent isolation claim.** The isolation granularity is the
  process that can read the key or reach the Workload API socket.
- **No whole-mesh claim.** NATS client mTLS covers client connections; routes,
  gateways, leaf nodes and WebSocket listeners each have their own settings,
  and only the server-to-server topology `ops/nats/` ships and tests is
  advertised.
- **No hardware binding.** Every supported custody above is software custody.
- **No certificate-mapping by default.** NATS `verify_and_map` is a distinct
  profile with its own bindings and tests, never enabled by `verify`.

## Consequences

- A remote peer that can reach a service now has to hold a private key the
  operator bound, and even then holds only the operations the binding lists.
  A copied environment variable is no longer sufficient network authority on
  an `mtls_required` service.
- The same deployment can keep `existing_local` on one hop and
  `mtls_required` on another, each declared; nothing chooses for the
  operator.
- The Host holds the keys of managed listener identities in sealed, exportable
  form (ADR 0075's trade, extended to transport). A gateway compromise yields
  those keys; that is why `managed_certificate` custody is opt-in and named
  truthfully.
- Operators gain a status surface that can say "configured but unverified"
  and "verified under generation 7, stale since generation 8". That is more
  words than a green dot and the difference is the point.
- The auth-callout bridge and the trusted ingress are high-trust components
  whose authority is narrowed and recorded, not eliminated. A compromised
  runtime uses the credentials available to it; a compromised CA issues
  identities that chain; the design narrows what those identities may do.
- The static PWA is unchanged in what it needs: nothing. Its settings can show
  transport status and desired policy for a configured remote target, and a
  target that is misconfigured is one broken target, not a setup wall.

## Alternatives considered

- **A service mesh sidecar or a commercial edge as the transport layer.**
  Would have put a vendor between the browser and the origin and made the
  static app's correctness depend on it. Vendor-neutral reference
  configuration (`ops/ingress/`, `ops/nats/`) instead.
- **Requiring a client certificate on some URL paths only.** The TLS handshake
  precedes the path; post-handshake renegotiation is unreliable under HTTP/2
  and browsers will not cooperate. Policy is per listener and per hostname.
- **`verify_and_map` as the NATS default.** The server's built-in DN/email/SAN
  mapping would reintroduce the name join ADR 0042 forbids. Admission plus the
  existing callout authorization is the default; mapping is opt-in with
  explicit bindings.
- **SPIRE as a required issuer.** Would add a baseline dependency to a system
  whose baseline is a static site. It is one supported source among three.
- **Building the EST server to honor the stale matrix row.** A speculative
  enrollment server to justify mTLS would have been the largest new
  cryptographic surface in the change, unrelated to the outcome. The row is
  corrected instead.
- **A single `secure: true` boolean.** Cannot express "server TLS but not
  mTLS", "mTLS behind an ingress", or "existing local, on purpose", and
  invites an "auto" that becomes a fallback.
- **Trusting `Client-Cert` headers whenever the request arrived over HTTPS or
  from a private address.** A certificate is public; the header proves nothing
  about possession. Only a bound ingress identity on the declared listener may
  present one.

## Evidence

The rows below map each advertised guarantee to the code that implements
it, the component that enforces it, the failure behavior, and the test that
exercises it. `docs/validation/mtls-implementation.md` (SW-INTEGRATION) is the
executed record — commands, exit codes, tree identifier; a row here is a map,
not a run.

**Reconciliation, 2026-09-22 ~03:15 UTC (SW-DOCS, against the live working
tree).** Present: `crates/domain/src/transport`, `crates/transport-security`,
`crates/spiffe-source`, `crates/ingress-evidence`, `packages/ingress-evidence`,
`packages/os-domain/src/transport-security/`, `packages/contracts`
transport-security schemas + fixture corpus, `packages/capability-registry`
entries, `packages/oauth-provider/src/mtls`, `apps/control-plane/src/transport`,
`apps/pages` transport settings + `scripts/verify-transport.mjs`,
`ops/ingress/Caddyfile`, the four `scripts/mtls-*` runners and the root
`test:mtls*` scripts. **Absent at that time:** `apps/gateway/src/transport`
(admission, bindings CAS, status, probe, trust routes), any change to
`apps/gateway/src/identity_mapping.rs`, `apps/gateway/src/routes/nats_callout.rs`,
`apps/worker`, `crates/task-bus/src/nats.rs` or `crates/provider-openbao`,
`crates/nats-callout`, `ops/nats`, `tests/mtls-interop`, `tests/mtls-adversarial`,
`docs/security/mtls-threat-model.md`, `docs/validation/mtls-implementation.md`,
`apps/pages/scripts/verify-browser-cert.mjs`, and
`crates/ingress-evidence/tests/reference_proxy.rs` (named by the Caddyfile
header). Every status below is one of `implemented`, `passed`, `failed`,
`not_executed`, `unsupported`; "passed"/"failed" cite the only executed
evidence available to SW-DOCS, SW-TESTOPS's fast-suite run 2
(`artifacts/mtls/runs/fast-20260922T003024Z-25681`, tree `b5d5603` + dirty);
SW-DOCS executed no suite itself. A guarantee whose enforcing component was
absent is `not_executed` however complete its pure half is.

| Guarantee | Implementing call site | Enforcing component | Failure behavior | Test path | Status at reconciliation |
|---|---|---|---|---|---|
| Verified evidence cannot be deserialized | `crates/domain/src/transport/evidence.rs` (`VerifiedPeer`, no `Deserialize`), `attest.rs`; TS `packages/os-domain/src/transport-security/evidence-view.ts`, `codec.ts` | Rust type system; TS type guards | compile error / `malformed_configuration` on bad selectors, times, thumbprint | `crates/domain/src/transport/evidence_tests.rs`, `source_contract_tests.rs`; `packages/os-domain/src/__tests__/transport-security.test.ts`; `packages/contracts/src/__tests__/transport-security.test.ts`, `transport-security-corpus.test.ts` | implemented; TS suites **passed** (run 2); Rust `opensesame-domain` **failed** to build in run 2 (in-flight unrelated module), not re-run |
| Bindings default-deny, exact selectors, no wildcard/CN/email | `ServiceBindingSet::resolve` / `validate`, `crates/domain/src/transport/binding.rs`, `selector.rs` | `apps/gateway/src/transport/admission.rs` | `peer_not_bound`, `ambiguous_binding`, `evidence_revoked`, `binding_disabled` | `binding_tests.rs`, `binding_validate_tests.rs`, `selector_tests.rs`; corpus `packages/contracts/fixtures/transport-security/{valid,invalid}` | domain implemented; admission **absent** → not_executed |
| Real chain/signature/time/usage verification by rustls + webpki | `crates/transport-security/src/{identity,trust,server,client,verify_spiffe}.rs` | rustls 0.23 / rustls-webpki | handshake alert; `key_pair_mismatch` / `trust_unknown` at load | `crates/transport-security/tests/{handshake_valid,handshake_reject,identity,servername,openssl_oracle}.rs` | implemented; crate tests **failed** to compile in run 2 (in-flight `handshake_valid`), not re-run |
| No client certificate on `mtls_required` → no handler runs | `listener.rs` + `provenance.rs` (`PeerExtension` only after authentication) | `SecureListener` | handshake failure before routing | `tests/handshake_reject.rs`; interop `tests/mtls-interop/` | implemented; interop **absent** → not_executed |
| Plain listener cannot serve an `mtls_required` purpose | `plain_provenance_layer` (`provenance.rs`) present; `ServiceCallerExtractor` | gateway admission | 403 `listener_policy_mismatch` | `apps/gateway/src/transport/*_tests.rs` | extractor and tests **absent** → not_executed |
| Missing/invalid material refuses to start, never downgrades | Rust `env.rs`; Identity `apps/control-plane/src/transport/config.ts` (`assertTransportSecure`, `loadTransportMaterial`) | process startup | Host `Err` / worker exit / Identity throws `key_pair_mismatch`, `trust_unknown` | `apps/control-plane/src/transport/__tests__/config.test.ts`; Host/worker startup tests | Identity implemented, its transport suite **failed** in run 2 (in flight); Host/worker wiring **absent** → not_executed |
| Resumption / tickets / 0-RTT off on privileged profiles | `server.rs` `server_config`: `max_early_data_size = 0`; when `policy.authenticates_client()`: `NoServerSessionStorage`, `send_tls13_tickets = 0`, `send_half_rtt_data = false` | rustls config | full handshake forced; early data refused | no dedicated resumption test found at reconciliation (AT-TLS-RESUME: SW-TLS/SW-SECURITY) | implemented (verified in source); not_executed |
| Existing connection denied after revocation / rotation | `guard.rs::check_peer_freshness` → `generation_stale`, `evidence_expired` past `usable_until`, `evidence_revoked` | per-request guard, wired by gateway admission | denial on the next protected request | `crates/transport-security/tests/generations.rs`; gateway AT-TLS-REVOKEDLIVE | guard implemented; gateway wiring **absent** → not_executed |
| Atomic generation activation; malformed candidate cannot extend expiry | `generations.rs` (`TransportGenerations::activate` / `withdraw`) | `crates/transport-security` | previous generation kept within its own validity | `tests/generations.rs` | implemented; execution as the crate row above |
| SPIFFE exact-ID selection, per-domain bundles, snapshot replacement, bounded outage | `crates/spiffe-source/src/{config,svid_profile,bundles,snapshot,outage,sink}.rs` (`spiffe` 0.16.1) | source → `TransportGenerations` | `identity_missing` on withdrawal; `trust_unknown` for a foreign domain | `src/*_tests.rs`; `tests/{synthetic_workload_api,isolation_binding,spire_reference}.rs` | implemented; crate **failed** to build in run 2 (in flight); SPIRE reference run needs fixtures → not_executed |
| Host → Identity mapping over mTLS keeps egress fences | `apps/gateway/src/identity_mapping.rs` + `OPENSESAME_MAPPING_TLS_*` | mapping client | `Unauthorized`; no secret fallback | `apps/gateway/src/identity_mapping_tests.rs` | file **unchanged** at reconciliation (bearer only) → not_executed |
| Identity admits the mapping principal for `principals.mapping.resolve` only | `apps/control-plane/src/transport/{mapping-auth,service-admission}.ts`, `listener.ts`; wired in `server.ts` | Identity receiver | 403 `peer_disallowed` | `__tests__/listener.test.ts`, `ingress-listener.test.ts` | implemented; suite **failed** in run 2 (in flight), not re-run |
| RFC 8705 client auth and `cnf.x5t#S256` binding | `packages/oauth-provider/src/mtls/feature.ts`, `clients/origin-resolve.ts`, `create-provider.ts`; resource check `apps/control-plane/src/transport/resource-binding.ts` (`rejectMismatchedBoundBearer`) | Identity provider + Identity protected routes; Host caller resolution | `proof_mismatch`; DPoP unchanged | `packages/oauth-provider/src/__tests__/metadata-transport.test.ts` (+ whole suite); Host `apps/gateway/src/middleware/auth.rs` tests | Identity side implemented, oauth-provider suite **passed** (run 2); Host-side `cnf` check **absent** → not_executed |
| RFC 9440 fields accepted only from a bound ingress on the `trusted_ingress` listener | `crates/ingress-evidence`, `packages/ingress-evidence`; Identity `ingress.ts`, `ingress-evidence-adapter.ts`; `ops/ingress/Caddyfile` | admission | `forwarded_evidence_unverified`; bounded parse rejects before any handler | `crates/ingress-evidence/src/{parser_tests,corpus_tests}.rs`; `packages/ingress-evidence/src/{corpus,node}.test.ts`; `__tests__/ingress-listener.test.ts`; `crates/ingress-evidence/tests/reference_proxy.rs` | parsers implemented and **passed** (run 2, Rust 10 tests + TS); reference-proxy driver **absent** → not_executed; Host side absent |
| Originating identity is request-local over a pooled ingress connection | `VerifiedPeer::ingress()`; Identity `request-evidence.ts` | admission | the other request's grant does not apply | `ingress-listener.test.ts`; AT-INGRESS-POOL in `tests/mtls-interop/` | Identity implemented; interop **absent** → not_executed |
| NATS client requires TLS, verifies server, presents identity, no downgrade on reconnect | `crates/task-bus/src/nats.rs`, `OPENSESAME_NATS_*` | async-nats 0.50 options | connect error; no memory-bus fallback | `crates/task-bus` (`--features jetstream`); `ops/nats/` | file **unchanged** (bare `async_nats::connect`), `ops/nats` **absent** → not_executed |
| Native `$SYS.REQ.USER.AUTH` callout bound to request, bridge bound to Host | `crates/nats-callout`, `opensesame-nats-auth-bridge`, `apps/gateway/src/routes/nats_callout*.rs` | Host decision + bridge binding | deny on unverified upstream token, wrong bridge cert, tampered response | `crates/nats-callout` tests; AT-CALLOUT-* | crate **absent**, route **unchanged** (shared secret) → not_executed |
| OpenBao `auth/cert` with narrow role; token lifetime independent of certificate | `crates/provider-openbao` | OpenBao | login refused; token TTL governs | `tests/mtls-interop/` (AT-OPENBAO-REAL/TOKEN) | crate **unchanged** (token header only) → not_executed |
| Browser vault-key injection reported `unsupported`; no export | `crates/domain/src/transport/capability.rs`; `packages/os-domain/src/transport-security/capabilities.ts`; `apps/pages/src/lib/transport-status.ts::browserCapabilities`, `transport-capability.ts` | contracts + Pages | typed `unsupported` outcome | `capability_tests.rs`; `apps/pages/src/lib/transport-capability.test.ts` | implemented; Pages transport tests **passed** (run 2) |
| Enforcement `verified` only by positive + negative probe bound to a generation | `POST /api/v1/operator/transport/verify` (`apps/gateway/src/transport/probe.rs`); consumer `apps/pages/src/lib/transport-status.ts`, `transport-rows.ts` | Host status | `unverified` / `stale` otherwise | gateway `*_tests.rs`; `apps/pages/scripts/verify-transport.mjs` (AT-EVIDENCE-STALE) | browser consumer implemented; Host route **absent** → not_executed |
| Static PWA needs no optional infrastructure; no native TLS in the bundle | `apps/pages`; `scripts/mtls-static-imports.mjs` | `verify:static`, `verify:transport`, static-imports gate | any loopback request, setup wall, or native token in the bundle fails | `apps/pages/scripts/verify-static-origin.mjs`, `verify-transport.mjs`; `scripts/mtls-static-imports.mjs` | static-imports **passed** (runs 1 and 2: 69 chunks, four browser packages clean); browser journeys not_executed by TESTOPS (`it-browser`) |

Rows whose test path names a file that is absent from the tree at the time
`docs/validation/mtls-implementation.md` is written are recorded there as
`not_executed`, not inferred from this table.

## References

- [docs/operators/mtls.md](../operators/mtls.md) — reference configuration,
  rotation, revocation bounds, diagnostics
- [docs/security/mtls-threat-model.md](../security/mtls-threat-model.md) —
  trust-boundary matrix and attack corpus
- [docs/validation/mtls-implementation.md](../validation/mtls-implementation.md)
  — executed commands and results
- [docs/reference/standards-matrix.md](../reference/standards-matrix.md) — RFC 8705, 9440, 9525,
  9325, 7030 and SPIFFE rows
- ADR 0005, 0017, 0042, 0048, 0068, 0075, 0090, 0128
- RFC 8705, RFC 9440, RFC 9525, RFC 9325, RFC 9449, RFC 7030; SPIFFE
  X.509-SVID and Workload API standards; NATS ADR-26
