# Threat model: optional mTLS and workload identity

Scope: the transport-authentication work of
[ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md) — the Host
secure listener, the worker listener, the Host→Identity mapping client, the
NATS auth-callout bridge and its Host decision route, the trusted-ingress
profile, connector transport to upstream targets, and the browser-managed
certificate capability.

This document was written by the independent review swarm (SW-SECURITY) from
the production call sites, not from the implementing swarms' reports. Where a
claim could not be verified in code it says so.

**What this feature does.** It narrows *who may open a connection to a
particular service endpoint* and records provenance for what happened on it.
Concretely: a peer must present a certificate that chains to a named trust
bundle, an administrator must have bound that exact peer identity to a service
principal for that purpose, and the operation must be on that binding's
allowlist. Each of those is a separate check and each can be observed
separately.

**What it does not do.** It does not authenticate a human, authorize an
action on a resource, bound what an already-issued token can do, or survive
the compromise of a runtime that legitimately holds a credential. Those
limits are stated per boundary below and again in
[§5 Residual realities](#5-residual-realities).

---

## 1. Trust-boundary matrix

Each row is one field or assertion that some component downstream treats as
true. "Producer" is what puts the value there; "Verifier" is the exact code
that decides whether to believe it; "Freshness" is the bound after which the
value is no longer accepted.

### 1.1 Browser (`apps/pages`, `apps/pwa`)

| Trusted field | Producer | Verifier (file → function) | Scope | Freshness | If the producer is compromised |
|---|---|---|---|---|---|
| Client TLS certificate on a request to a remote org operation | The operating system / browser certificate store, provisioned outside OpenSesame | The receiving origin's TLS stack; the page never sees it | That origin's listener only | The handshake; then the origin's `usable_until` | The browser can use any certificate the OS will hand it, to any origin that asks. Browser certificate use is ambient, so Origin/CSRF/consent checks remain load-bearing. |
| `capabilities.browser_vault_key_injection` | Compiled constant | `crates/domain/src/transport/capability.rs` — always `Unsupported` | — | — | n/a. A page cannot put a vault key into a TLS handshake; nothing in the product pretends otherwise. |
| Transport status shown in Settings | The Host status route, fetched by the page | `apps/pages/src/lib/transport-*.ts` render only; no page value feeds authorization | Display | Whatever the Host says | A hostile Host can show a misleading status. It cannot change what any listener enforces. |

The static app boots, unlocks and runs its local journeys with none of this
configured. An unconfigured transport feature is not an error state.

### 1.2 Human vault

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| Vault item private keys | The device, inside the vault envelope | `crates/human-vault` | The device | Vault lifetime | The vault's contents are exposed. **No transport code path reads a vault key**: the identity sources are a deployment-plane PEM pair, a Host managed certificate, or a SPIFFE Workload API SVID (`crates/transport-security/src/env.rs`). Revoking a transport certificate does not erase or re-lock anything already on the device. |

### 1.3 Native executor (Host, worker, bridge — a process holding a key)

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| Our own presented chain and key | `NativeIdentitySpec` — PEM files, a managed certificate id, or a SPIFFE SVID | `TlsIdentity::from_pem` (`crates/transport-security/src/identity.rs`): key/cert match, CA-as-leaf refused, expired-at-load refused | This process | `not_after`; a generation is only activated after whole-candidate validation (`generations.rs::activate`) | The process can open every connection its credential permits, for as long as the credential is valid. This is the irreducible case: a certificate authenticates the runtime, not the code running in it. |
| Generation currency | `TransportGenerations` | `guard.rs::check_peer_freshness` on every protected request | Process-wide | Immediate on the next request after `activate`/`withdraw` | An attacker inside the process controls its own generations. The bound matters for *peers*, not for the holder. |
| Custody label reported in status | `Custody` enum | `crates/domain/src/transport/capability.rs` | Display + policy | — | The SPIFFE Workload API hands the private key to the workload. The status says `workload_api_delivered`, not hardware-protected — the key is ordinary process memory. |

### 1.4 Service peer (a client certificate on our listener)

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| Chain validity, client-auth usage, revocation | The peer | rustls `WebPkiClientVerifier` with the bundle's CRLs, wrapped by `bounded.rs::BoundedClientVerifier` (chain depth ≤ `MAX_CHAIN_DEPTH`) | The listener | The handshake | A peer with a valid key for a bound identity is that service until the binding, the thumbprint denylist or the certificate says otherwise. |
| Peer identity selectors (SPIFFE ID, DNS name, URI SAN, leaf thumbprint) | The certificate's SANs | `leaf.rs::ParsedLeaf::parse` → `build_selectors`, then `selector.rs::validate` | The peer's identity for binding lookup | Bound to the handshake | **CN, `rfc822Name` and IP SANs are never selectors**, wildcards and trailing-dot names are dropped, and two `spiffe://` SANs produce *no* SPIFFE identity rather than a choice. Proven by `crates/transport-security/tests/identity_adversarial.rs`. |
| Service principal and allowed operations | Administrator configuration (`OPENSESAME_SERVICE_BINDINGS_FILE`, or `host_kv` under CAS) | `ServiceBindingSet::resolve_scoped` + `ServiceCaller::require_operation` | Exactly one live binding matching scope AND trust profile AND peer AND purpose | Binding `not_after`; peer `usable_until`; current generation | A compromised administrator can bind any peer. A compromised *peer* gains nothing beyond its own binding: the principal is an output of resolution and can never be supplied as an input. |
| The request may proceed at all | The listener | `apps/gateway/src/transport/admission.rs::peer_evidence` — a listener whose policy does not authenticate a client is refused outright | Per request | Per request | There is no weaker credential to fall back to; a purpose configured `mtls_required` has exactly one door. |

### 1.5 Ingress (RFC 9440 trusted-ingress profile)

A TLS-terminating proxy creates **two transport hops**. The origin sees the
proxy's handshake; the client's handshake happened at the proxy and cannot be
recreated at the origin.

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| The connection's own peer | The proxy | The origin's `SecureListener` against the *ingress* bundle | The trusted-ingress listener | The handshake | — |
| "This proxy may forward client evidence" | Administrator binding of purpose `trusted_ingress` with operation `ingress.forward` | `crates/ingress-evidence/src/admission.rs::BindingSetAdmission` | Deployment scope | Binding liveness | A bound proxy can assert any client its originating bundle will validate. That is its assigned authority. |
| `Client-Cert` / `Client-Cert-Chain` | The proxy | `fields.rs` (RFC 8941 decode, canonical base64 re-check, bounded to 64 KiB / 16 KiB / 8 members) → `verify.rs::verify_originating` (webpki path build against the *originating* bundle, client-auth usage, CRLs, window) | **This request only** — inserted into request extensions, never connection state | `min(ingress usable_until, leaf not_after)` | A bound proxy chooses which client to name. It cannot name one outside the originating bundle. |
| The evidence's label | `AttestedPeer::into_verified` | `crates/domain/src/transport/attest.rs` | — | — | The result is `trusted_ingress_assertion`, and `ingress()` carries the proxy's own verified peer. Re-validating a forwarded chain constrains acceptance; it does not prove the client possessed the key on this request. |

On every other listener the two fields are **removed** before the handler
runs (`layer.rs::strip`), so a direct client cannot forge them. Role
confusion in either direction is refused:
`crates/ingress-evidence/tests/role_confusion_adversarial.rs`.

### 1.6 NATS broker and the auth-callout bridge

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| "This arrived on my authenticated NATS connection, on the protected `$SYS.REQ.USER.AUTH` subject" | The bridge | Not verifiable by the Host. Bought with the bridge's mTLS client certificate plus a `nats_auth_bridge` binding allowing `nats.callout.decide` | Admission to the decision route | Binding + generation | The bridge holds the callout account signing seed, so it can sign responses to nats-server without asking the Host at all. Verified in `crates/nats-callout/src/response.rs::ResponseSigner::from_seed` and stated by SW-CALLOUT §0. **This is a high-trust component.** |
| The authorization request's provenance | nats-server's Ed25519 signature | `apps/gateway/src/routes/nats_callout_verify.rs::verify_request` — `typ`/`alg`, issuer is a server nkey **and** on `OPENSESAME_NATS_SERVER_NKEYS` (empty list ⇒ refuse all), signature, `iss == nats.server_id.id`, `aud`, `sub`, user nkey shape, 120 s window + 30 s skew | Per request | The JWT's own window | A compromised server can sign requests naming any user. The pin list bounds *which* servers. |
| The posted envelope (digest, user key, server id, nonce, evidence) | The bridge | Recomputed from the verified claims and compared; any disagreement is `envelope_mismatch` | Per request | — | A bridge cannot add a token or a certificate chain the server never signed for. |
| End-user identity | The upstream IdP / the user | `apps/gateway/src/callout_evidence.rs`, then Identity mapping | The decided connection | Token lifetime | Bridge authentication is *not* user authentication; the two are separate checks in that order. |
| `client_tls.certs` reported by nats-server | The connecting NATS client | Dropped by the evidence extractor unless nats-server itself verified it; a chain becomes identity only when certificate identity is enabled *and* the exact leaf SHA-256 is on `OPENSESAME_NATS_CALLOUT_CERT_PEERS` | Per request | — | Raw reported certificate fields never become an authenticated identity. |
| A repeated decision | The Host's replay record, keyed by the canonical request digest | `nats_callout_verify.rs::replay_key` + the stored decision | One digest | The decision's own validity | A replayed request yields the *same* still-valid decision, never a different one. Changing any claim changes the digest. |

**Not verified here:** receiver-enforced disconnect on authorization expiry
depends on the pinned nats-server build's behaviour. SW-NATS's live run is the
evidence for that; this swarm did not re-run it.

### 1.7 Identity provider plane (`apps/control-plane`)

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| Peer evidence on the Identity TLS listener | Node's TLS stack (`socket.authorized === true` + `getPeerX509Certificate()`) | `apps/control-plane/src/transport/peer-evidence.ts::attestPeer`, recorded in a module-private `WeakMap` keyed by socket identity | That socket | `min(1 h, certificate remainder)` | As §1.4. |
| Mapping-resolve authorization | Administrator choice of `OPENSESAME_MAPPING_AUTH` | `mapping-auth.ts::authorizeMappingResolve` — either the shared secret or an `identity_mapping_client` binding listing `principals.mapping.resolve`. Never both, never a fallback | That one operation | Per request | The bound service identity is authorized for that operation and nothing else; it holds no session and every other route still answers 401. |
| `cnf["x5t#S256"]` on a bearer token | The token issuer (oidc-provider) | `resource-binding.ts::evaluateCertificateBinding` against `bindingPeerOf(req)` — the *originating* client behind a trusted ingress, never the proxy leaf | Per request | Token lifetime | A token bound to certificate A presented on certificate B is refused, and one presented on the plain listener is refused for want of a peer. A different certificate carrying the same key has a different thumbprint and is also refused. |

### 1.8 Upstream target (connector transport)

| Trusted field | Producer | Verifier | Scope | Freshness | If compromised |
|---|---|---|---|---|---|
| Which identity a connection presents | An operator-registered **reference** on the connection record | `crates/connection-broker/src/transport.rs` — a value that looks like a path, socket or URL is refused at parse; `ClientIdentityResolver` must refuse a reference the calling organization does not own | That connection | Per invoke | A tenant cannot name a filesystem path, a CA bundle, a trust domain or a Workload API socket. Native source access is a deployment-plane capability. |
| Which pooled client carries a request | `transport_pool.rs` | Pool key = organization, connection, executor, authority, **leaf thumbprint**, trust profile **and generation**, policy | One tenant/connection/credential | A new thumbprint or trust generation builds a new pool | Two tenants never share an authenticated connection; a rotation never rides the old key's connection. |
| Where the request may go | Egress preflight, before any key use | `transport_execute.rs` (authorize → egress preflight → resolve identity → open credential → …) | The connection's approved authority | Per invoke | Redirect/DNS/private-host tricks are refused before the client key is used. |

---

## 2. Credential substitution — the central threat

The failure this design is built against is not a forged certificate; it is a
*genuine* certificate accepted next to a credential it has nothing to do with,
with the two silently unioned. Where each combination is refused:

| Substitution | Refused by |
|---|---|
| Tenant A's certificate with tenant B's connection | Pool key includes `organization_id` and `connection_id`; `require_delegated_caller` resolves in `BindingScope::Organization` and a deployment binding never satisfies it (`binding_adversarial.rs::scopes_do_not_satisfy_one_another`). |
| A workload certificate with a human actor's token | Admission produces a `ServiceCaller`, never a `Caller`. No transport path mints an operator session (`apps/gateway/src/transport/admission.rs` module docs and the absence of any `Caller` construction there). |
| A human session used to reach a service-only route | The route resolves a service caller; a session is not one. |
| The ingress's own leaf offered as the originating client | Different trust profile ⇒ `trust_unknown` (`role_confusion_adversarial.rs`). |
| The originating client's leaf offered as the ingress | Different client trust ⇒ the handshake fails. |
| A bound access token replayed on a different certificate | `evaluateCertificateBinding` thumbprint compare. |
| A bound access token replayed on the plain listener | No binding peer ⇒ `certificate_binding_missing_peer`. |
| A callout decision replayed against a different request | The replay record is keyed by the canonical request digest. |
| A token-derived identity disagreeing with a certificate-derived one | `nats_callout_verify.rs::reconcile` ⇒ `identity_mismatch`. The two are never unioned. |
| An unprivileged actor widening its own authority (trust profile, binding, identity reference, native source path, Workload API socket) | Operator routes are configurator-gated (`transport/routes.rs::require_configurator`); binding replacement is CAS on `revision`; references are refused at parse if they look like locators; only the deployment plane sets `OPENSESAME_SPIFFE_ENDPOINT_SOCKET`. |
| Amplification through status/probe/diagnostics | The probe's target is one of three fixed words and its route is always `/health/live` (`transport/probe.rs`); status carries no key, token, path or subject DN. |

---

## 3. What each enforced bound actually is

State these separately; collapsing them is how "revocation" becomes a
misleading word.

| Event | New handshakes | An open connection's next request | An in-flight request | An already-issued token |
|---|---|---|---|---|
| Thumbprint denied (`deny_thumbprint`, or a binding's `denied_thumbprints`) | Refused at the handshake | Refused (`evidence_revoked`) | Completes | **Unaffected** — token invalidation is a separate mechanism with its own TTL |
| Generation activated (rotation) | Use the new material | Refused (`generation_stale`); recovery is one handshake | Completes | Unaffected |
| Generation withdrawn (source revoked, SPIFFE snapshot dropped the identity) | Refused | Refused with the withdrawal reason | Completes | Unaffected |
| `usable_until` passed | n/a | Refused (`evidence_expired`) | Completes | Unaffected |
| Binding disabled or removed | Refused at admission | Refused at admission | Completes | Unaffected |
| CA removed from a trust bundle | Refused | Refused on the Host (generation check). **On the Identity plane this is bounded by `usable_until` (default 1 h), not by the generation** — see §5. | Completes | Unaffected |

Session resumption and early data are off on `mtls_required` and
`trusted_ingress` server profiles (`NoServerSessionStorage`, no ticketer,
`max_early_data_size = 0`), and the Identity listener sets `SSL_OP_NO_TICKET`
with a `resumeSession` hook that answers "no session". This is a product
choice for these profiles, not a claim that TLS resumption is unsafe.

---

## 4. Abuse cases and where each is exercised

| Abuse case | Test |
|---|---|
| Attacker-controlled CN, email SAN, IP SAN, wildcard, trailing dot, oversized SAN | `crates/transport-security/tests/identity_adversarial.rs` |
| Two SPIFFE SANs, percent-encoded/uppercase/dot-dot/query/fragment SPIFFE IDs, Unicode and NUL | same file; TS mirror in `apps/control-plane/src/transport/__tests__/peer-evidence_security.test.ts` |
| CA offered as a leaf, `serverAuth`-only EKU, unknown critical extension | `identity_adversarial.rs` |
| A SAN whose text equals a binding's service principal | `crates/transport-security/tests/binding_adversarial.rs` |
| Forged `Client-Cert` direct to the origin or on a non-ingress listener | `crates/ingress-evidence/tests/layer.rs` |
| Ingress/originating role swap; an unbound proxy forwarding a *valid* assertion | `crates/ingress-evidence/tests/role_confusion_adversarial.rs` |
| Malformed, duplicated, non-canonical or oversized RFC 9440 fields | `crates/ingress-evidence/tests/fields_adversarial.rs`, `src/corpus_tests.rs` |
| A correctly signed request from an unpinned server; a tampered genuine request; an unknown field in the bridge envelope | `crates/nats-callout/tests/envelope_adversarial.rs` |
| Concurrent activation, failed activation, revocation on an open connection, rotation + bounded recovery, binding replacement under concurrent admission | `crates/transport-security/tests/races_adversarial.rs` |
| Mutated certificates, mutated binding documents, arbitrary bytes into the real parsers | `crates/transport-security/tests/parse_adversarial.rs`; libFuzzer entry points in `fuzz/fuzz_targets/transport_*.rs` |
| Public construction of verified evidence | `crates/domain/src/transport/source_contract_tests.rs`; `peer-evidence_security.test.ts` |

---

## 5. Residual realities

These are properties of the design, not defects to be closed. Stating them is
part of the feature.

1. **A compromised runtime uses the credentials it has.** A certificate
   authenticates the process that holds the key, not the code executing in it,
   and the SPIFFE Workload API delivers that key into ordinary process memory.
   Per-workload certificates isolate workloads only to the granularity at
   which keys and execution are actually separated; sibling agents sharing a
   process or a readable key file can impersonate one another.
2. **A trusted ingress or the callout bridge asserts facts within its assigned
   authority.** A bound proxy chooses which client in the originating bundle
   to name. The bridge holds the callout account signing seed and can sign
   responses to nats-server without consulting the Host; the Host-side checks
   bound what a bridge obtains *through the Host*, not what it can do with
   that seed. Treat both as high-trust components and keep their own
   admission narrow.
3. **A compromised CA issues identities this deployment accepts** unless
   something further constrains them — which is what per-peer bindings,
   `denied_thumbprints` and thumbprint selectors are for. Trust-anchor
   installation is a privileged operator decision; nothing imports an anchor
   because a certificate, URL, manifest or CSR suggested one.
4. **Certificate revocation does not revoke tokens, sessions or grants.** An
   OpenBao token, an OAuth access token or a task grant minted while a
   certificate was good keeps its own lifetime. Define and operate that TTL
   separately. Do not describe a minted bearer token as certificate-bound
   unless the resource server actually enforces `cnf`.
5. **Revocation is bounded by the next check, not by the moment of the
   decision.** On the Host that is the next request on every open connection.
   On the Identity plane a *trust-bundle* change is bounded by the peer
   evidence's `usable_until` (default one hour) rather than by a generation
   comparison, because `admitService` does not compare generations; binding
   and `denied_thumbprints` changes do take effect on the next request there,
   because the binding set is read live. Shorten `usableForMs` if a tighter
   CA-removal bound is required.
6. **Cached application code runs without contacting an edge.** Protecting the
   HTML with a certificate does not protect offline vault access and does not
   erase anything already on a device. Local decryption controls are what
   protect the vault.
7. **Operator `PUT` CAS is per-replica.** `put_cas` serializes replacements
   inside one process and compares the document's `revision`, but two replicas
   can read the same revision and both write; the later write wins and both
   callers see success. Operate binding changes from one place, or treat the
   returned revision as advisory and re-read.
8. **Status shows bound peers' SAN text to operators.** It is bounded (≤ 2048
   bytes per selector, ≤ 1024 bindings) and carries no subject DN, path, key
   or token — but it is attacker-influenced text and should not be used as a
   metric label.
9. **A successful authenticated connection proves acceptance, not
   enforcement.** `EnforcementStatus::Verified` is written only by the probe,
   which runs both halves (with and without a certificate) and records them
   separately, with a 15-minute freshness bound.

---

## 6. See also

- [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md) — the decision
- [docs/operators/mtls.md](../operators/mtls.md) — configuration and recovery
- [docs/security/threat-model.md](threat-model.md) — the product-wide model
- [docs/security/security-boundaries.md](security-boundaries.md)
- [docs/validation/mtls-implementation.md](../validation/mtls-implementation.md)
  — what was executed, by whom, with exit codes
