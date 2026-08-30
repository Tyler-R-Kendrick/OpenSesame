# Threat Model — OpenSesame

Method: STRIDE + asset/actor/data-flow analysis.

## Assets
- Human vault plaintext / VRK / PCK / IDK (client-only)
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
3. Authority plane (OpenBao/KMS)
4. WASM capability boundary
5. Public callback edge (narrow)
6. Mesh transport (not authorization)

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
| Supply chain | pins, deny, SBOM, signatures | CI |

## Credential / authority abuse (added)

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| Agent knows ConnectionRef → extracts secret | Resolve/Materialize denied without export grant | `authz::authority_use` |
| Gateway string-replaces SecretRef to attacker URL | Egress binding + typed ops; no generic substitution | `EgressBinding`, connector-host redirect tests |
| Authenticated 302 to evil.example | Cross-authority redirect denied while credential held | `follow_redirect_with_credential` |
| WASM `secrets.get` | Not in WIT imports; authorized-http/sign only | `wit/connector/world.wit` |
| SecretRef late-binding into agent env | Agent API is ConnectionRef+Intent (ADR 0005) | domain `resolve_secret_for_agent` |
| Unconstrained placeholder substitution (email token away) | Placement + max occurrences fail-closed | `PlaceholderPlacement` / connector-host |
| Same-UID agent reads host keychain | Host agent session capability; sandbox egress via broker | credential-agent + ADR 0006 |
| Agent `materialize` via `.env` | DevDeliveryPolicy denies materialize for agents | `opensesame dev --agent` |
| Root or leaf key exposed by certificate ceremony/storage | Host generates keys; authority and delivery records are sealed with organization/purpose AAD | gateway/storage certificate tests; ADR 0052 |
| Duplicate request mints multiple certificates | Request digest + organization idempotency constraint + transactional issuance record | gateway certificate idempotency/chaos tests |
| External CA outage silently downgrades trust | Selected/default external issuer fails closed; no private-CA fallback | `adversarial_external_issuer_failure_never_downgrades_to_private_ca` |
| Certificate delivered to another actor | Expiring delivery is creator-bound and deleted after acknowledgement | gateway cross-actor/ack tests |
| ACME or DNS endpoint pivots to internal network | Fixed HTTPS issuer endpoints, no redirects, bounded responses, DNS-01 connection allowlist | ACME/DNS adapter adversarial tests |

See ADR 0005–0006 and SUDP (arXiv:2604.24920) for custodian execution semantics.

## Certificate Manager (ADR 0066–0072, added)

Anchors named as forthcoming files are the ones the Certificate Manager swarms
create; each is the file that will hold the test, per the implementation plan.

| Threat | Mitigation | Test anchor |
|--------|------------|-------------|
| ACME enrollment by anyone who can reach the directory | External Account Binding required on every profile's `new-account`; EAB HMAC sealed under `eab_secret` | `apps/gateway/src/routes/acme_server.rs` EAB tests (ADR 0068 §2) |
| ACME JWS replay | Single-use nonces minted in `acme_nonces`, consumed on every POST; order/authz lookups bound to the requesting account | `acme_server.rs` replayed-nonce and cross-account-order tests |
| ACME HTTP-01 validation used to pivot into internal hosts | Sanctioned raw-egress path constrained to the order's own identifiers; no redirect to a different identifier; size- and time-bounded | `acme_server.rs` challenge-fetch adversarial tests |
| Skip-validation profile issues for a name the claimant does not control | Admin-enabled per profile only, never a fallback from failed HTTP-01; issuance audit event records it; bounded by EAB + policy name constraints | `acme_server.rs` skip-mode tests (ADR 0068 §3) |
| SCEP challenge bypass or reuse | Static challenge stored hashed and sealed, compared in constant time; dynamic challenges one-time, expiry ≤1440 min, pending set ≤1000, consumed exactly once | `apps/gateway/src/routes/scep_server.rs` fixture interop tests |
| EST enrollment with a forged bootstrap identity | Bootstrap certificate validated against the operator-uploaded chain; passphrase sealed under `est_passphrase`; re-enrollment may require mTLS with the certificate being replaced | `apps/gateway/src/routes/est_server.rs` bootstrap tests |
| Enrollment CSR requests attributes the operator never intended | Profile policy evaluated at finalize/enroll; violating CSR refused, never narrowed | `crates/pki-core` policy property tests |
| CRL forgery or rollback to an older signed CRL | CRL signed by the issuing CA through the `Signer` trait; `cRLNumber` monotonic per CA, never timestamp-derived or reused; DER sealed at rest with org/CA-bound AAD | `crates/pki-core` revocation tests; `crl_state` storage tests (ADR 0067 §2, §7) |
| CRL staleness leaves a revoked certificate accepted | Regeneration on revoke **and** on `next_update` horizon by the lifecycle actor; revocation record commits even if signing fails, actor retries | `apps/gateway/src/cert_lifecycle.rs` inline tests (ADR 0067 §3) |
| OCSP response forged by a non-delegated signer | Responder signs with the CA key or a delegate that is issued by that same CA and carries `id-kp-OCSPSigning`; validated at configuration time, not response time | `crates/pki-core` OCSP delegation tests (ADR 0067 §6) |
| OCSP asserts `good` for a serial the CA never issued | Unknown serials return `unknown`, never `good` | `crates/pki-core` OCSP tests |
| Sync destination redirected to attacker infrastructure | Destinations are admin-configured connections; every push through `ConnectionBroker::authorized_json` with the connection's egress allowlist; no URL/host/credential field in any sync request body; redirects are responses, never chased | `apps/gateway/src/cert_syncs/` adapter tests (ADR 0069 §2a) |
| Sync used as a key-export channel | Key unsealed only inside the sync actor pass, in a non-`Clone`/non-`Serialize` carrier with redacting `Debug`; no route response, run record, log, error or audit payload contains it | `cert_syncs` adapter + `certmgr_syncs.rs` projection tests (ADR 0069 §2b) |
| Agent creates or triggers a sync to exfiltrate a key | `certmgr.sync.*` excluded from `mcp_host`, `mcp_client` and `webmcp`; parity test fails if ever mapped | `packages/capability-registry/src/registry.test.ts` (ADR 0069 §2d) |
| Certificate delivered to the wrong destination object | Name schema validated at write time over a fixed variable set with per-destination sanitization; unknown variables rejected, not passed through literally | `cert_syncs` name-schema unit tests |
| Signing approval scope-pin evasion | Every present pin field must match exactly; mismatch denies and is ledgered; `data_hash` binds a pre-approval to one input; `ip` is server-observed (trusted-proxy configuration required) | `apps/gateway/src/routes/certmgr_signers.rs` scope tests (ADR 0070 §3) |
| Signature-counter race turns a one-signature approval into many | Counter increment, record read and `signing_events` append in one transaction under the row's optimistic `version`; losing writer re-reads or is denied | `certmgr_signers.rs` concurrency test (ADR 0070 §4) |
| Approval mutated after grant, or self-approved | Access records immutable after approval — amendment requires a new request; self-approval forbidden by default | `certmgr_signers.rs` + approval-engine tests |
| Credentials leak into the signing activity ledger | Command lines redacted at **write** time against an argument-name denylist plus value-shape heuristics, deliberately over-eager; never stored verbatim | `certmgr_signers.rs` redaction tests (ADR 0070 §6) |
| Code-signing private key exfiltrated | Signers have no key read path at all — no resolve, materialize or export ceremony; Sign API takes a digest and returns a signature only | `certmgr_signers.rs` + `assertsNoSecretTools` (ADR 0070 §1, §2) |
| Sign API abused as a data-upload channel | Digest-only intake: fixed-length hex validated against the declared algorithm, 64 KiB body limit, no artifact/multipart/URL intake | `certmgr_signers.rs` request-hygiene tests |
| HSM PIN read back or leaked in a projection | PIN sealed under `hsm_pin` with org/connector-bound AAD; no reveal ceremony; connector `*_view` omits it; `certmgr.connector.hsm` excluded from every agent surface | `certmgr_connectors.rs` projection tests; registry parity (ADR 0071 §2, §5) |
| HSM connector pointed at an attacker-supplied module (`dlopen` as configuration) | PKCS#11 module path is gateway operator configuration; the connector row names only an expected module hint, never a path | `crates/hsm-client` + `certmgr_connectors.rs` tests (ADR 0071 §2) |
| HSM connector silently addresses the wrong token after a restart | Slots addressed by operator-assigned label, never by index; verify-on-create performs a live sign-and-verify round trip before `status = verified` | `crates/hsm-client` SoftHSM2 / mock-token tests (ADR 0071 §2, §5) |
| CA key exposed anywhere in a multi-level hierarchy | Every CA key sealed under `certificate_authority` scope or held in an HSM; all signing (issuance, CRL, OCSP) through one custody-agnostic `Signer` trait, so no path bypasses custody; no sealed→HSM in-place migration, because it would require exporting the key | `crates/pki-core` `Signer` tests; `certmgr_ca.rs` tests (ADR 0071 §4) |
| Compromised intermediate used to mint beyond its intent | Path-length constraint enforced on creation and on chain validation; imported signed intermediate must chain to the named parent; profile policy constrains what each CA may issue | `certmgr_ca.rs` hierarchy tests |
| Cross-tenant certificate, CA, signer or revocation disclosure | Every new table carries `organization_id` with composite `UNIQUE(organization_id, id)` and tenant-pair FKs; every accessor org-scoped; non-member of an application gets 404, not 403 | storage cross-org isolation tests; `certmgr_app.rs` tests (ADR 0066 §3) |
| Unauthenticated CRL/OCSP endpoints leak tenant structure | Read-only, CA-id path parameter only; identical shape for "no such CA" and "CA with no CRL"; no organization identifiers emitted; body/encoded-request limits; contract-allowlisted with a category comment | `apps/gateway/src/routes/revocation.rs` tests (ADR 0067 §8) |
| Discovery scanner used as an SSRF probe | Sanctioned raw-egress path constrained to the job's declared targets; job caps (≤20 domains, ≤256 IPs, CIDR ≥ /24, ≤5 ports); allow-internal flag honored; concurrency and timeout capped | `apps/gateway/src/cert_discovery.rs` limit-enforcement tests |
| Discovered certificate silently enters the authoritative inventory | Discovery writes installation records only; promotion to inventory requires an explicit import action | `certmgr_discovery.rs` + `certmgr_inventory.rs` tests (ADR 0066 §4) |

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
  surface (sqlx, oauth2, jsonwebtoken, chacha20poly1305, task bus) —
  enforced by `scripts/daemon-deps-gate.sh` (`pnpm audit:daemon-deps`).

Test anchors: `crates/connection-detect` (canary/no-value-escape
properties), `apps/daemon` promote/invoke-through canary tests, fuzz
targets `mcp_config`, `ini_parse`, `whois_response`, `promote_request`.
