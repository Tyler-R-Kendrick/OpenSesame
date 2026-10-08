# Threat Model — OpenSesame

Method: STRIDE + asset/actor/data-flow analysis.

## Assets
- Human vault plaintext / vault key (VK) / VRK / IDK (client-only; see [key hierarchy](key-hierarchy.md))
- Authority credentials (OAuth refresh, CA keys, dynamic secret engines)
- Grants, policy model, revocation state
- Claim tokens / device codes (one-time secrets)
- Receipt signing keys
- Connector components (signed OCI)

## Actors
Human, device, workload, service, agent, agent instance, malicious connector, compromised node, malicious admin, external IdP, public callback edge.

## Trust boundaries
1. Client crypto boundary (E2EE)
2. Gateway PEP
3. Authority plane (OpenBao provider, Host sealing root)
4. WASM capability boundary
5. Public callback edge (narrow)
6. Transport admission — a native TLS peer or a bound ingress (authentication, never authorization; ADR 0132)

## Browser-to-Host authority lifecycle

Assume a public origin, dependency, or other same-origin application can execute
hostile JavaScript, a bearer can be copied, a local process can reach loopback,
and authorization changes while a request or stream remains open. A URL path
does not isolate projects sharing an origin. A trusted browser origin is not
an operator, and a non-extractable DPoP key does not defeat same-origin XSS.

Local browser pairing grants only a narrow origin/key/audience-bound sync
capability. Explicit Identity evidence is required for the enumerated ordinary
user ceiling; route-level ownership, organization and current project policy
still apply. Native administration and materialization remain outside that
ceiling. Recent verified WebAuthn evidence and a one-use frozen authorization
are both required for browser-control transitions. Credential class, proof,
principal, organization, exact origin, audience, operation and lifetime are
independent checks, not interchangeable indications of trust.

Membership narrowing and authentication issuance share the evidence-replay
transaction. The native revocation floor must not become a last-login timestamp
that rejects independent legitimate challenges. Control effects and elevation
consumption commit together. Long-lived observation streams recheck browser
grant validity, verified evidence, current membership and ownership before
polling or releasing buffered ciphertext; already delivered bytes cannot be
recalled. A concurrently revoked in-flight event is bounded, not magically
retracted. Native session streams recheck their live session record.

Strict deployment/exposure parsing and pre-startup secret validation keep an
omitted or mistyped environment label from enabling ambient development authority.
These controls do not make backend availability a condition for opening the
offline Pages vault or choosing guest access, and Identity sign-in does not
prove possession of the vault key.

See [Host authority review](audits/2026-09-08-host-authority.md) for implementation
anchors, focused results, remaining validation and residual trust. Its
Host-specific passkey contract does not upgrade unrelated interaction approvals.

## High-risk abuse cases & mitigations

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| Token theft via logs/env | Opaque handles, redaction, host agent | `crates/redaction`, CLI tests |
| Claim/device code replay | Hash-at-rest, single-use, expiry | `crates/claims`, authn tests |
| Confused deputy / MCP passthrough | Separate inbound/outbound creds; audience validation | gateway authn tests |
| SSRF via connector | Host allowlist, DNS/IP checks | connector-host tests |
| Cross-tenant access | Org FK + policy + opaque IDs | authz policy fixtures |
| Extension message forgery | Origin/frame binding; no getSecret | browser tests |
| Quorum loss write | A2/A3 fail closed | availability tests |
| Malicious WASM | Capability denial + digest verify | sandbox tests |
| Rotation failure | verify-before-revoke, reconcile | rotation tests |
| Supply chain | pins, deny, SBOM, signatures | CI; `cargo deny` runs in the nightly dependency-triage routine |

## Credential / authority abuse (added)

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| Agent knows ConnectionRef → extracts secret | Resolve/Materialize denied without export grant | `authz::authority_use` |
| Gateway string-replaces SecretRef to attacker URL | Egress binding + typed ops; no generic substitution | `EgressBinding`, connector-host redirect tests |
| Authenticated 302 to evil.example | Cross-authority redirect denied while credential held | `follow_redirect_with_credential` |
| WASM `secrets.get` | Not in WIT imports; `host-http`, `host-crypto` (purpose-bound `sign`) and `host-oauth` only | `spec/wit/connector/world.wit` |
| SecretRef late-binding into agent env | Agent API is ConnectionRef+Intent (ADR 0005) | domain `resolve_secret_for_agent` |
| Unconstrained placeholder substitution (email token away) | Placement + max occurrences fail-closed | `PlaceholderPlacement` / connector-host |
| Surrogate reflected through the allowed host (gist/issue body) to read the credential back | Recognize, strip, re-place: the credential is written only into the provider's own site; a surrogate anywhere else is refused (ADR 0150 §2) | `surrogate_tests::a_surrogate_in_the_body_is_refused_even_beside_a_valid_header` |
| Allowed upstream echoes the presented credential in its response | Response scrub (raw, percent, base64 at every alignment) before the caller sees it (ADR 0150 §4) | `invoke_tests::a_reflected_credential_never_reaches_the_caller` |
| Surrogate exfiltrated and replayed / sent to attacker host | Caller-bound, run-revocable, exact-host; every refusal is a `surrogate.*` tripwire with one client message (ADR 0150 §3, §5) | `surrogate_tests`, `surrogate_lifecycle_tests` |
| Same-UID agent reads host keychain | Host agent session capability; sandbox egress via broker | `crates/daemon` + ADR 0006 |
| Agent `materialize` via `.env` | DevDeliveryPolicy denies materialize for agents | `opensesame dev --agent` |
| Root or leaf key exposed by certificate ceremony/storage | Host generates keys; authority and delivery records are sealed with organization/purpose AAD | gateway/storage certificate tests; ADR 0052 (automatic certificate authority selection) |
| Duplicate request mints multiple certificates | Request digest + organization idempotency constraint + transactional issuance record | gateway certificate idempotency/chaos tests |
| External CA outage silently downgrades trust | Selected/default external issuer fails closed; no private-CA fallback | `adversarial_external_issuer_failure_never_downgrades_to_private_ca` |
| Certificate delivered to another actor | Expiring delivery is creator-bound and deleted after acknowledgement | gateway cross-actor/ack tests |
| ACME or DNS endpoint pivots to internal network | Fixed HTTPS issuer endpoints, no redirects, bounded responses, DNS-01 connection allowlist | ACME/DNS adapter adversarial tests |

See ADR 0005–0006 and SUDP (arXiv:2604.24920) for custodian execution semantics.

## Certificate Manager (ADR 0066–0072, added)

Only part of the Certificate Manager design is in the tree. Present: the
`crates/pki-core` library (issuance, CRL and OCSP building), the migration 0016
schema, certificate authority, policy and profile routes
(`/api/v1/certmgr/{cas,policies,profiles}`, including a profile's `est-config`),
and EST enrollment at `/.well-known/est/{profileId}/*`. Not built: ACME and SCEP
servers, CRL and OCSP endpoints, certificate syncs, discovery, code signing,
HSM/PKCS#11, and the Kubernetes external issuer (ADR 0072). Rows below name what
exists as a control. A row marked **not in this tree** is an ADR design whose
endpoint, actor or crate is absent, so it is a requirement on whoever builds it,
not a mitigation.

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| ACME server abuse: enrollment by anyone who can reach the directory, JWS replay, HTTP-01 used to pivot inward, skip-validation issuing for a name the claimant does not control | **Not in this tree.** ACME is not served (ADR 0068 §1–§3 design); `crates/storage/src/acme.rs` persists accounts, orders, challenges and single-use nonces only | `crates/storage/src/acme.rs` |
| SCEP challenge bypass or reuse | **Not in this tree.** SCEP is not served (ADR 0068 §4 design). Storage keeps SCEP configuration and one-time challenges by hash; a conditional update lets exactly one racing consumer burn a challenge | `crates/storage/src/est_scep.rs` |
| EST enrollment with a forged bootstrap identity | Bootstrap certificate matched against the operator-uploaded chain; passphrase sealed under `est_passphrase` and compared in constant time; re-enrollment may require mTLS with the certificate being replaced | `crates/gateway/src/routes/est_wire.rs`, `est_server_tests.rs` |
| Enrollment CSR requests attributes the operator never intended | Profile policy evaluated at enroll; a violating CSR is refused whole (`policy_denied`), never narrowed | `crates/gateway/src/routes/est_enrollment.rs`, `crates/pki-core/src/policy.rs` tests |
| CRL forgery or rollback to an older signed CRL | Library only: `build_crl` signs with the issuing CA key and embeds the caller's `cRLNumber`; `verify_crl` checks a CRL against its issuer. **Not in this tree:** a gateway route or actor that generates, stores (the `crl_state` row and the sealed `crl_der` scope exist but nothing writes them) or serves a CRL, so monotonic numbering and sealed-at-rest storage are ADR 0067 §2, §7 requirements, not exercised end to end | `crates/pki-core/src/revocation.rs` tests, `crates/pki-core/tests/behavior.rs` |
| CRL staleness leaves a revoked certificate accepted | **Not in this tree.** ADR 0067 §3 calls for regeneration on revoke and at the `next_update` horizon by a lifecycle actor; none exists | — |
| OCSP response forged by a non-delegated signer | Library only: `build_ocsp_response` signs with the key it is handed and names the responder `byName` for the issuer's own key, `byKey` otherwise. It does not check that a delegate was issued by the CA or carries `id-kp-OCSPSigning`; ADR 0067 §6 puts that check at configuration time and no configuration path exists | `crates/pki-core/src/revocation.rs` (`a_delegated_responder_signs_with_its_own_key`) |
| OCSP asserts `good` for a serial the CA never issued | `status_for` answers `unknown`, never `good`, for a serial absent from the issued set | `crates/pki-core/src/revocation.rs` tests |
| Sync destination redirected to attacker infrastructure, sync used as a key-export channel, agent-triggered sync | **Not in this tree.** Certificate syncs (ADR 0069) have schema only (`cert_syncs`, `sync_runs`); there is no adapter, actor, route or capability-registry entry | `crates/storage/migrations/0016_certificate_manager.sql` |
| Signing approval scope-pin evasion, signature-counter race, approval mutated after grant, credentials in the signing ledger, code-signing key exfiltration, Sign API as upload channel | **Not in this tree.** Code signing (ADR 0070) has storage only (`signers`, members, signing-access records and events in `crates/storage/src/signing*.rs`); no route or signer implementation exists, so no key is held and no Sign API is served | `crates/storage/src/signing.rs`, `signing_access.rs` |
| HSM PIN leaked, HSM connector pointed at an attacker-supplied module, wrong token addressed after a restart | **Not in this tree.** There is no PKCS#11 client, HSM connector route or `crates/hsm-client` (ADR 0071 design); a CA's `key_source = 'hsm'` can be recorded but nothing can sign for it | `crates/pki-core/src/signer.rs` (`Signer` has only `SealedKeySigner`) |
| CA key exposed in a multi-level hierarchy | Every CA key is sealed under the `certificate_authority` scope. The `Signer` trait exists, but issuance and CRL building take the CA's `KeyPair` directly; no sealed-to-HSM path exists | `crates/gateway/src/routes/certmgr_ca.rs` (`seal_ca_key`, `open_ca_key`) |
| Compromised intermediate used to mint beyond its intent | Path-length constraint enforced on creation (`path_len_exceeded`); an imported signed intermediate must chain to the named parent; profile policy constrains what each CA may issue | `crates/gateway/src/routes/certmgr_ca.rs` tests |
| Cross-tenant certificate, CA or revocation disclosure | Every certificate-manager table carries `organization_id` with composite `UNIQUE(organization_id, id)` and tenant-pair FKs; accessors are organization-scoped, so an id outside the caller's organization answers 404 | `crates/storage/tests/certmgr_pact.rs`, `certmgr_behavior.rs`, `certmgr_chaos.rs` |
| Unauthenticated CRL/OCSP endpoints leak tenant structure | **Not in this tree.** No CRL or OCSP endpoint is mounted (ADR 0067 §8 design); when one is added it must answer "no such CA" and "CA with no CRL" identically and emit no organization identifiers | — |
| Discovery scanner used as an SSRF probe; discovered certificate enters the authoritative inventory | **Not in this tree.** Discovery (ADR 0066 §4) has storage only (`crates/storage/src/discovery.rs`); no scanner or route exists | `crates/storage/src/discovery.rs` |

## Transport security and workload identity (ADR 0132)

The full trust-boundary matrix, attack corpus and property tests for this
area are in [mtls-threat-model.md](mtls-threat-model.md). This section states
the shape of the claim and the residual realities the design does not remove.
ADR 0132 § Evidence records, with a timestamp, which anchors were present and
which suites had run.

The claim is narrow: on a hop configured `mtls_required` or `trusted_ingress`,
a caller must hold a private key that chains to the operator-installed trust
profile **and** match exactly one operator-written service binding **and** pass
the same authorization every other caller passes. A certificate is
authentication of a key holder. It is not a session, a tenant, an operator, a
device, a person, or evidence that the process holding it has not been
compromised.

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| Credential substitution — tenant B's valid leaf presented with tenant A's bearer, ConnectionRef, NATS claim, pooled client or forwarded header | Factors combine only under an explicit binding: `cnf.x5t#S256` compared to the originating leaf; callout decision bound to request digest + server context + one-time user key + bridge identity; client pools keyed by tenant, connection, executor, credential and trust generation; ingress evidence request-local | AT-OAUTH-SWAP, AT-CALLOUT-REPLAY, AT-CALLOUT-PROVENANCE, AT-CONNECTOR-POOLS, AT-INGRESS-POOL (`tests/mtls-interop/`, `crates/domain/src/transport/*_tests.rs`) |
| Forged `verified: true`, thumbprint or principal in JSON, header, query or plugin manifest | `VerifiedPeer` has no `Deserialize`; the only constructor is `attest::AttestedPeer::into_verified`, called by the rustls verifier (`crates/transport-security`) and the ingress-evidence verifier; the Node TLS socket adapter attests through its TS mirror (`attestPeer`) | AT-TLS-FAKECONTEXT (`crates/domain/src/transport/evidence_tests.rs`, `source_contract_tests.rs`) |
| Valid certificate from the trusted root with no binding, wrong purpose, or a name that "looks like" a service | Default deny; exact `spiffe_id` / `dns_name` / `uri_san` / `leaf_thumbprint_sha256` selectors only; no CN, email, IP or wildcard; one match or denial | AT-TLS-WRONGSERVICE, AT-CALLOUT-BRIDGE (`binding_tests.rs`, `crates/gateway/src/transport/`) |
| Bridge or ingress launders claims it did not verify | Bridge authentication and end-user authentication are separate: Host verifies the upstream token's issuer, audience, signature and expiry itself; RFC 9440 fields accepted only from a bound `trusted_ingress` peer on that listener and labelled `trusted_ingress_assertion` | AT-CALLOUT-CLAIMS, AT-INGRESS-SPOOF, AT-INGRESS-WRONGPEER |
| Plaintext or alternate listener offers the same protected operation | Purpose-to-listener policy: `403 listener_policy_mismatch` on the plain listener; health exceptions narrow and explicit; direct-origin, alternate host/port and IPv6 paths tested | AT-TLS-PLAINTEXT, AT-INGRESS-ORIGIN |
| Revoked or rotated identity keeps working on an open connection | Per-request recheck of binding revision, `denied_thumbprints`, trust/credential generation and `usable_until`; NATS authorization expiry enforced server-side; resumption and 0-RTT disabled on privileged profiles | AT-TLS-REVOKEDLIVE, AT-TLS-RESUME, AT-NATS-LIVEEXPIRY |
| Half-installed rotation: new chain with old key, or a malformed update that extends expiry | Whole-generation validation before atomic activation; a bad candidate leaves the previous generation inside its own validity only; a Workload API snapshot that omits an SVID or bundle withdraws it | AT-ROTATE-ATOMIC, AT-SPIFFE-WITHDRAW |
| Wrong-domain SPIFFE bundle accepted through a union trust store | Per-trust-domain bundles; a foreign-domain SVID is `trust_unknown` | AT-SPIFFE-FEDERATION |
| Tenant names an arbitrary file path, socket, URL or trust domain through a connection object | Native source and trust selection is deployment-plane environment only; connections carry references to already-authorized identities; API bodies reject unknown fields | AT-CUSTODY-SOURCE, AT-CUSTODY-BOOTSTRAP |
| Private key revealed through status, diagnostics, errors, logs or an agent tool | `PeerEvidenceView` carries thumbprints and selectors only; `TlsIdentity`'s `Debug` never prints the key; managed-key reveal stays the ADR 0075 human-plane route and is excluded from every agent surface; verify probes take no host, URL or path from the caller | AT-CUSTODY-HUMAN, AT-EVIDENCE-PROBE, AT-EVIDENCE-LOGS |
| Green status read as enforcement | Five independent status dimensions; `enforcement: verified` only from a positive **and** negative probe bound to a generation, and `stale` once that generation moves | AT-EVIDENCE-POSITIVE, AT-EVIDENCE-STALE |
| Browser asked to "use the vault key for TLS" | `browser_vault_key_injection` is always `unsupported`; no export, no proxy, no helper fallback; browser-managed certificates are external custody | AT-BROWSER-KEY |

Residual realities, stated rather than implied:

- A compromised runtime uses whatever credentials it can read. Custody here
  is software custody — a PEM file, a Host-sealed key the Host can open, an
  SVID the Workload API handed over — and none of it is called hardware-bound.
- Processes that share a Workload API socket under one attestation share an
  identity. There is no per-subagent cryptographic boundary.
- The auth-callout bridge and a trusted ingress can assert facts within the
  authority their bindings grant. Their authority is narrowed and recorded,
  not eliminated.
- A CA that is trusted can issue identities that chain. Bindings limit what
  those identities may do; they do not detect a compromised issuer.
- Revocation is bounded per layer (next handshake; next protected request;
  the NATS expiry; the OpenBao or OAuth token's own TTL). It is never instant
  across a fleet, it does not revoke tokens already issued, and it erases
  nothing from a browser: cached application code still runs and the local
  vault still opens with its local protectors.
- The PWA cannot observe whether the browser sent a certificate; it reports
  desired policy and what a configured native verifier last observed, never a
  self-certified enforcement state.

## Daemon discovery scanner access profile (ADR 0047–0049)

The daemon's connector-discovery scanner is designed so an EDR rule can
allowlist its *exact* access profile — anything outside it is, by
construction, not the scanner:

- **Reads:** an injected environment snapshot (never the process
  environment directly), the enumerated dotfile paths
  (`~/.vault-token`, `~/.bao-token`, `~/.aws/credentials`,
  `~/.aws/config`, the gcloud ADC JSON), MCP client configuration files
  for server names and env *key names* only, OS keychain **labels** via
  the platform enumeration APIs (Secret Service / macOS Keychain /
  Windows Credential Manager — values are never requested, so no ACL
  prompt is triggered), and CLI probe **exit codes** via a scrubbed-env,
  no-shell, timeout-bound runner that never returns stdout bytes. Every
  file read is size-capped; oversized files are skipped, not truncated.
- **Network:** none. Probes are pure functions over an injected
  `ProbeContext` (contract C2); there is no socket, HTTP client, or URL
  anywhere in the probe API, and no probe validates a credential (a test
  is an oracle).
- **Writes:** none in discovery. `/v1/discover` is operator-gated and
  rate-limited despite mutating nothing, because its threat is
  disclosure.
- **Promote (`POST /v1/promote`)** is the only value-reading path, and it
  reads *exactly one* operator-confirmed source per call — one env var,
  one dotfile under the read cap, or one named MCP env value — after
  re-deriving the offer set rather than trusting the request. Keychain
  and CLI-tool sources have no readable material in v1.
- **Dependency profile:** `connection-detect` is serde + serde_json +
  thiserror + std; the daemon must not gain the credential-exchange
  surface (sqlx, oauth2, jsonwebtoken, chacha20poly1305, task bus, wasmtime) —
  enforced by `scripts/audit/daemon-deps-gate.sh` (`pnpm audit:daemon-deps`).

Test anchors: `crates/connection-detect` (canary/no-value-escape
properties), `crates/daemon` promote/invoke-through canary tests, fuzz
targets `mcp_config`, `ini_parse`, `whois_response`, `promote_request`.

## Breach scanner access profile (ADR 0080)

The breach scanner adds the gateway's first outbound calls to a third party
that is neither a credential provider nor a customer endpoint, so its access
profile is stated the same way the daemon's discovery scanner is — anything
outside it is, by construction, not the scanner:

- **Network:** exactly two request shapes, both to Have I Been Pwned, both
  confined to `crates/gateway/src/breach/sources.rs`, both with redirects
  disabled and a 15-second timeout.
  - `GET https://api.pwnedpasswords.com/range/{prefix}` with
    `Add-Padding: true`. The path carries **five hexadecimal characters** of a
    SHA-1 and nothing else; `range_url` interpolates the prefix only, and a
    unit test asserts the suffix never appears in the URL. The response is
    matched locally, and padding means its size discloses nothing either.
  - `GET https://haveibeenpwned.com/api/v3/breaches`. Unauthenticated, carries
    no tenant data at all, and the body is size-capped (16 MiB) so an
    impersonated source cannot make a pass allocate without bound.
- **What is deliberately absent:** the breached-account API. It would require
  sending the account identifiers a tenant manages, which are not ours to
  disclose. Provider coverage is obtained by matching the public catalogue
  locally instead.
- **Reads:** connection *metadata* only — the egress authorities each
  connection is bound to reach. The scanner opens no sealed column, so a
  gateway with no sealing key still gets provider coverage.
- **The one secret-accepting route.** `POST /api/v1/security/breach-check` is
  the only route in the product whose body carries a secret value. It is
  owner/admin or operator gated, bounded at 4 KiB, hashed once, and the hash
  is not persisted. The value is never written to the database, never logged,
  never returned, and never included in a published event; the copy the
  handler owns is zeroized. It is excluded from every agent surface
  (`security.breach_check.run`), because an agent surface must never be the
  thing that carries a secret — even to have it vetted.
- **Writes:** `breach_findings` rows, which are metadata. There is
  deliberately no column for a hash or a hash prefix: a stored SHA-1 of a
  password is a crackable artifact, and keeping one to save a re-check next
  pass would be a bad trade for a system whose claim is that it holds no
  recoverable copy of what it protects. The cost of that choice is that
  periodic re-checking of stored passwords is not offered — only
  check-at-set-time, which is where NIST SP 800-63B puts it anyway.
- **Egress from the notification path:** alert sinks are absolute `https://`
  only and re-checked against the private/metadata-address fence at send time,
  not only at registration. There is no `syslog` delivery kind: RFC 5424 lines
  are emitted to the host's own log stream rather than over plaintext egress.

Test anchors: `crates/breach-intel` (k-anonymity and value-blindness
properties), `crates/gateway/src/routes/security.rs` (metadata-only findings,
refusals that do not echo the candidate), `crates/gateway/src/security/sinks.rs`
(no sink renders a secret-shaped key).

## Cross-device interaction layer (ADR 0086)

The interaction layer's whole security claim is one sentence: **a reference
authorizes nothing.** Everything below is either a consequence of that or an
attack on it.

The reference (`i_<id>.<mac>`) travels somewhere no other OpenSesame artifact
goes — onto a screen, into a camera, into a Google Wallet pass, past whoever is
standing behind the user. So it is modelled as public from the moment it is
minted, and the question is never "how do we keep it secret" but "what is it
worth to hold one".

### QR is transport, never authentication

A QR code is a picture of a string. It can be photographed, screenshotted,
re-rendered, substituted on a poster, and sent to someone else. The layer is
built so that all of those are true and none of them matter:

| Attack | Why it fails |
|--------|--------------|
| Screenshot replayed later | The reference resolves to a terminal status. `consumed`, `expired` and `revoked` never reopen (`machines/interaction.ts`), so a photograph of a spent interaction is a photograph of a receipt. |
| Screenshot replayed *before* consumption | Resolving yields `InteractionSummary` — kind, status, expiry. Approving needs an authenticated approver *and* a proof bound to the digest. The finder has neither. |
| QR scanned twice, or by two apps | `present()` is idempotent and is a display fact with no authorization meaning. Two scans are one event. |
| Malicious QR substituted on a poster | The victim is handed an interaction the attacker created. It can only settle *that* interaction, whose approver is the attacker — so the victim is asked to approve something they did not initiate, and the binding message is derived from the operation rather than written by the requester (`deriveBindingMessage`). Substitution becomes a phishing problem, addressed by what the screen says, not an authorization bypass. |
| QR carrying a bearer | Cannot be produced. `assertNoForbiddenParams` runs inside the link builder and inside QR encoding, over `FORBIDDEN_URL_PARAMS`. |
| Rotating Wallet barcode treated as an assurance upgrade | It is not one, and is reported as `rotatingBarcode: false` for generic passes rather than claimed. Rotation improves presentation freshness; assurance comes from the proof. |

### Enumeration and oracles

An interaction id is 18 random bytes. The reference additionally carries an
HMAC, so a fabricated reference is refused before any lookup. Malformed,
forged, and never-existed produce one response at one cost. The resolve
endpoint is therefore not a probe for which interactions are real, and not an
amplifier for database load.

The approver is addressed by the ADR 0046 `inbox_…` handle, not by a principal
id, so learning who someone is remains insufficient to put text in front of
them.

### Link leakage

The reference sits in the URL *path*, never the query or fragment. That is a
trade made deliberately: a path is visible in server logs and `Referer`
headers, which a fragment would not be — but a fragment is invisible to the
server, and this reference must reach the server to be resolved. Since the
reference is worth nothing on its own (§ above), the leak-resistant placement
buys nothing and costs the ability to use it. Bearers keep using the fragment
(`readFragmentToken`, ADR 0045); references do not need to.

### What an approval proves, and what it does not

The digest binds *what* was approved. A spent activation binds *who* approved it
and *how strongly*, and the proof that reaches the audit trail is derived on the
server.

`/v1/interactions/{ref}/approve` accepts the request-digest echo and the id of a
completed activation, and nothing else. A proof field in the body is a 400, and
an approval with no matching activation is `proof_required`. An ordinary
session may deny (authority only shrinks) but cannot approve.

An activation (`packages/control-plane/src/routes/interaction-activation.ts`) is
minted for one interaction, one approver and the decision `approved`, lasts at
most five minutes, and carries a transaction digest over the interaction id,
request digest, approver, decision, policy digest and channel. For WebAuthn the
challenge is bound to that digest and the raw assertion is verified before the
activation completes; approve then spends it once, by compare-and-set. The
sealed proof records `phishing_resistant` for the `webauthn` mechanism and `mfa`
otherwise.

Which mechanism suffices depends on the kind. `authorization_request`,
`transaction_authorization` and `grant_claim` may only be approved by a
phishing-resistant mechanism, so a TOTP activation is refused for them
([ADR 0125](../adr/0125-wallet-native-proof-admission.md)); other kinds accept `mfa`. An earlier implementation accepted the
entire `ApprovalProof` — mechanism, assurance, credential handle — from the
request body and stored it as though checked, so any authenticated caller could
write `phishing_resistant` into an audit trail having touched no key. Every
field is now server-derived, and the client's declaration is discarded. The
residual risk is stated rather than implied: for a kind that accepts `mfa`, an
interaction is approvable by anyone holding the approver's session token and a
current TOTP code, and the digest constrains *what* is approved, not *who*
approved.

### Digest-bound approval

The mutation families that must invalidate an approval — amount, currency,
payee, action, resource, scope, TTL, an added second transaction, a reordered
detail list — each have a test asserting the digest moves
(`packages/os-domain/src/__tests__/transaction-binding.test.ts`). Fields are
length-prefixed, so text cannot be moved across a field boundary to forge a
collision.

TOCTOU between display and execution is closed on the storage side: the
repository patch type for an interaction admits `status` and decision fields
only. `requestDigest`, `authorizationDetails`, `bindingMessage` and `expiresAt`
are not patchable, so a settled interaction cannot come to describe something
other than what was approved.

### Concurrency

One approved interaction yields exactly one consumption. `consume()` states the
rule; the `updateWithVersion` compare-and-set is what enforces it against two
racing executors. An application-level status check alone would double-execute,
which for a `payment_initiation` means paying twice.

### Vendor compromise and outage

Google Wallet is a presentation adapter. Nothing in the approval path calls
Google, so:

- a Google outage cannot weaken authorization or lock a user out of OpenSesame;
- a compromised Google response cannot bypass server-side policy, because a
  pass carries a reference and a reference authorizes nothing;
- removing a pass removes a convenience, not an identity. Pass revocation and
  identity revocation are separate operations, in that order of blast radius.

Pass payloads are checked by `assertPassPayloadSafe` on every issue in
production — not only in tests — against tokens, claim tokens, JOSE, PEM
headers, PANs and forbidden parameter names anywhere in the serialized object.

### Presented details are attacker-authored

A payee name, a resource path and a requester label are strings someone else
chose. They are rendered as text, never HTML, and are stripped of control
characters and bidirectional overrides (U+202A–U+202E, U+2066–U+2069) before
display: a right-to-left override in a payee name reorders what the user reads
without changing what they approve, which is a signature-spoofing vector
against exactly the screen this layer exists to make trustworthy. They are also
truncated, and they never enter audit metadata — the audit row keeps
`bindingMessageDigest`, so a reviewer can prove which words were shown without
the store holding the words.

### Payment scope

The transaction model carries an amount, a currency and a payee display name.
Card data is refused mechanically by field name and by Luhn-checking string
values, so a PAN under an innocuous key is refused too, and the refusal names
the path rather than echoing the value. OpenSesame does not store PAN/CVV,
provision DPANs, or integrate a card network TSP; PCI DSS scope is avoided by
construction rather than by policy.

Test anchors: `packages/os-domain/src/__tests__/` (state machine, references,
transaction binding), `packages/ceremony-kit` (link construction and forbidden
parameters), `packages/wallet` (pass payload safety), `packages/openid4vp`
(presentation verification and replay).
