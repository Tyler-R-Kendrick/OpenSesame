# Certificate Manager implementation evidence

Status: **evidence template — implementation partly landed.** The sections below
are written from the committed plan and from ADRs 0066–0072, and each says what
exists in this checkout and what does not. Every **numeric** result — coverage, mutation,
fuzz executions, test counts, scan cost — is marked
`_pending: fill from the run of <command>_` and MUST be replaced with a measured
value from an actual run. Do not substitute an estimate, a previous release's
number, or a number carried over from
`docs/validation/automatic-certificate-issuance.md`.

## Reconciled baseline and stack

- Predecessor evidence:
  [`docs/validation/automatic-certificate-issuance.md`](automatic-certificate-issuance.md)
  (ADR 0052-cert issuance stack), which remains valid for everything it covers.
- Implementation plan:
  [`docs/archive/plans/plans/2026-08-30-infisical-cert-manager-parity-swarm.md`](../archive/plans/plans/2026-08-30-infisical-cert-manager-parity-swarm.md).
- Integration base commit: _pending: fill from `git rev-parse origin/main` at
  integration time._
- Implementation head: _pending: fill from `git rev-parse HEAD` at integration
  time._
- Toolchain: Rust 1.88 (`cargo +1.88.0`), Node ≥ 22, pnpm 9.15.0, Turbo 2.9.14,
  Biome 1.9.4, Vitest 4.1.11, Playwright 1.55.1 — as pinned in `AGENTS.md` §2.

## Delivered behavior

Present in this checkout: the `opensesame-pki-core` engine
([`crates/pki-core`](../../crates/pki-core)); the certificate-manager schema
(migration `0016_certificate_manager.sql`) and its persistence layer in
`crates/storage`; the Host routes for authorities, policies and profiles
(`/api/v1/certmgr/cas`, `/policies`, `/profiles`,
`/profiles/{id}/est-config` in `crates/gateway/src/routes/certmgr_*.rs` and
`est_server.rs`); and the EST server (`/.well-known/est/{profileId}/…`). The
routes are still allowlisted in `crates/gateway/src/routes/contract.rs`
("while the surface is still being assembled") rather than published in
`spec/openapi/host-api.yaml`. Everything else the headings below describe — CRL
and OCSP endpoints, the ACME and SCEP servers, syncs, discovery, alerts,
approvals, signers and the Sign API, HSM connectors, the PKCS#11 module, the
Windows KSP and the Kubernetes issuer — has no route, actor or crate in this
checkout. Those sections state the design of ADRs 0067–0072 and say which part
(if any) exists.

### Domain model (ADR 0066)

Certificate management walks one object chain: certificate authority → policy →
profile → application → enrollment config → certificate. Policies are pure
constraint documents with three-state field rules; profiles bind a CA, a policy
and defaults; applications are service workspaces whose members hold
`admin`/`operator`/`auditor` roles. Inventory rows carry a `source` of
`issued`, `imported` or `discovered`, and renewal is a bidirectional link
(`renewed_from_id` / `renewed_by_id`), one renewal per certificate, with custom
metadata carried across.

The routes cover authorities, policies and profiles, for callers who pass
`Caller::can_configure_integrations` (the operator, or a session whose role is
owner or admin; `crates/gateway/src/middleware/auth.rs`);
another organization's object is a 404, never a 403. Applications, their
members, the role ladder (`opensesame_storage::Role`), inventory sources and
renewal links exist as schema and storage accessors (`pki_applications`,
`insert_renewal_link`); no gateway route manages an application, and no
`admin`/`operator`/`auditor` gate runs in the gateway. The CA, policy and
profile routes append a `certmgr.<object>.<verb>` outbox audit event after the
state change, in a separate transaction (`certmgr.ca.created`, `.updated`,
`.imported`, `.renewed`, `.signing_config_updated`; `certmgr.policy.*` and
`certmgr.profile.*` for create, update and delete). A policy or profile create
whose audit append fails is undone. `PUT .../est-config` appends no audit event.

The existing `/api/v1/certs/*` routes are unchanged and remain the
zero-configuration issuance path.

### Certificate authorities

Root and intermediate CAs with path-length constraints and full DN fields; key
algorithms RSA-2048, RSA-4096, ECDSA P-256, ECDSA P-384 (the engine also
generates Ed25519 for leaves; the authority routes refuse it);
externally-signed intermediates via CSR export and signed-chain import; CA
renewal in both same-key and new-key modes, with previously issued certificates
remaining valid across a new-key renewal.

### Revocation (ADR 0067)

Revocation writes an immutable record (`certificate_revocations`) with an RFC
5280 `CRLReason` code; today the transport-certificate revoke route
(`POST /api/v1/operator/transport/certificates/revoke`, ADR 0132) is the only
caller. `opensesame-pki-core` builds, parses and verifies CRL v2
(`revocation::build_crl`, `parse_crl`, `verify_crl`) and RFC 6960 OCSP requests
and responses, signed by the CA key or by a delegated responder, from a
`KeyPair`; the custody-agnostic `Signer` trait (`SealedKeySigner`) exists but no
builder takes it yet. A CA's signing configuration stores `crl_enabled` and up
to four advertise-only mirror URLs, and storage holds `crl_state` and the
`crl_der` seal scope.

Not implemented: `GET /crl/{caId}.crl`, `GET /crl/{caId}.pem` and the OCSP
responder at `/ocsp/{caId}` (no such route in `crates/gateway`); the lifecycle
actor that would regenerate a CRL on revoke and at `next_update`; and CRL
Distribution Point embedding in issued leaves (the engine can emit one, but
EST enrollment passes none, `routes/est_enrollment.rs`).

### Enrollment protocols (ADR 0068)

Implemented, profile-scoped: EST (RFC 7030) `cacerts` / `simpleenroll` /
`simplereenroll` at `/.well-known/est/{profileId}/…`
(`crates/gateway/src/routes/est_server.rs`). A caller authenticates with the
profile's sealed bootstrap passphrase (HTTP Basic), a verified TLS client
certificate chaining to the configured bootstrap chain, or the certificate being
replaced (re-enrollment); `require_bootstrap` demands a client certificate. A
policy-violating CSR is refused whole, never narrowed, and issued certificates
are recorded in the inventory (`routes/est_records.rs`). The operator surface is
`GET|PUT /api/v1/certmgr/profiles/{id}/est-config`.

Not implemented: the ACME server (RFC 8555, mandatory per-profile EAB,
single-use nonces, HTTP-01 validation or skip-validation) and the SCEP server
(RFC 8894 `GetCACaps` / `GetCACert` / `PKIOperation`, static and one-time
dynamic challenges). Only their storage exists — the `acme_*` and `scep_*`
tables, with single-use `consume_acme_nonce` and `consume_scep_challenge` — and
no route in `crates/gateway` serves either protocol.

Client side: upstream HTTP-01 and TLS-ALPN-01 remain refused
(`ChallengeKind::require_dns01` in `crates/gateway/src/cert_issuers/model.rs`;
ADR 0052-cert's rationale restated — DNS-01 is a strict superset). The external
issuers are the code-owned registry in
`crates/gateway/src/cert_issuers/registry.rs` (Let's Encrypt, ZeroSSL,
Cloudflare Origin CA), where `public_web` trust is pinned. Registering a private
ACME directory (trust class `private_local`) is not implemented;
`external_ca_configs` allows the kind `private_acme` as schema only.

### Lifecycle, discovery, alerting, approvals

Implemented: the renewal link between a certificate and its successor
(`insert_renewal_link`, `mark_certificate_renewed`), used by host-custody
renewal in `crates/gateway/src/managed_certs.rs` (ADR 0075).

Not implemented — storage only (`crates/storage/src/{discovery,cert_alerts,approval_policies,approval_requests}.rs`;
no route or actor in `crates/gateway` calls them): certificate cleanup N days
past expiry; network TLS discovery jobs (planned limits ≤20 domains, ≤256 IPs,
CIDR ≥ /24, ≤5 ports, plan §5.11) tracking installations by SHA-256 fingerprint
across scans; expiration/issuance/renewal/revocation alerts over email, Slack,
PagerDuty Events v2 and CloudEvents 1.0 webhooks with HMAC-SHA256 signatures;
multi-step M-of-N approval workflows with max-request-TTL and machine-identity
bypass.

### Code signing (ADR 0070)

Design only. No Sign API route, `SignerRef` type, PKCS#11 provider module or
Windows KSP exists in this checkout. Storage holds the data model (`signers`,
`signer_members`, `signing_access_records`, `signing_events`, the `signer_key`
seal scope, an atomic `increment_signature_count`). The design: signers are
authority handles with **no key read path of any kind** — not even a human
ceremony; the Sign API takes a precomputed digest and returns a signature and
never accepts an artifact; approvals pin any subset of command, application
name, application SHA-256, hostname, OS username, server-observed IP and data
hash, and become immutable access records with signature counters and signing
windows; a PKCS#11 v2.40 sign-only provider module (`cdylib`) proxies to the
Sign API over the daemon socket, and a Windows CNG KSP is build-only; every
attempt — succeeded, failed or denied — appends to the per-signer activity
ledger with credential arguments redacted at write time.

### HSM connectors (ADR 0071)

Design only. No `cryptoki` dependency, HSM client or connector route exists;
storage holds `hsm_connectors` (a label, a sealed PIN under the `hsm_pin` scope
with no read path, a key-label prefix, a verification status). The one trace in
the Host is `PATCH /api/v1/certmgr/cas/{id}/signing-config`, which accepts a
`key_source` of `sealed` or `hsm` (the latter with an `hsm_connector_id` and an
`hsm_key_label`) and stores it; nothing reads it back to pick a signer. The design: a
PKCS#11 client over `cryptoki`; connectors carry a slot **label** (never an
index); mechanisms RSA PKCS#1 v1.5 (raw and SHA-256/384/512) and ECDSA
SHA-256/384/512; key generation RSA-2048/4096 and P-256/P-384; verify-on-create
performs a live sign-and-verify round trip; PIN rotation touches only the
connector row; HSM-held keys implement the same `Signer` trait as sealed keys,
so CA, CRL, OCSP and signing code is custody-agnostic.

### Syncs (ADR 0069)

Design only. Storage holds `cert_syncs` and `sync_runs`
(`crates/storage/src/cert_alerts.rs`); no sync actor, destination adapter or
route exists. The design: push a certificate, its chain and where applicable its
private key to administrator-configured destinations through
`ConnectionBroker::authorized_json`; unseal key material only inside the sync
actor pass and never return it to any caller; emit an outbox audit event and a
`sync_runs` record per push; gate SSH and WinRM executors behind default-off
cargo features, following ADR 0053; exclude `certmgr.sync.*` from every agent
surface.

### Kubernetes issuer (ADR 0072)

Design only. There is no `apps/k8s-issuer` (the apps are `android`,
`browser-extension`, `browser-extension-autofill`, `cli` and `pages`), no
`kube` or `k8s-openapi` dependency and no `Issuer` / `ClusterIssuer` CRD in this
checkout. The design: a kube-rs controller exposing those CRDs in group
`certmgr.opensesame.dev`, reconciling cert-manager `CertificateRequest`s against
the API-enrollment route with machine-identity authentication and surfacing the
issuing chain in `ca.crt`. The stock cert-manager ACME issuer would need the ACME
server, which is also not implemented.

## Schema and configuration

`crates/storage/migrations/0016_certificate_manager.sql` follows the conventions of the applied
`crates/storage/migrations/0013_certificate_issuance.sql`: `TEXT` primary keys, RFC3339 `TEXT`
timestamps, `organization_id TEXT NOT NULL REFERENCES organizations(id)`,
composite `UNIQUE(organization_id, id)`, optimistic `version` on mutable rows,
and all-or-nothing `CHECK` groups on sealed-blob column sets
(`*_key_id`, `*_ciphertext`, `*_nonce`, `*_aad_digest`). The
one-default-per-organization partial unique index is 0013's
(`idx_certificate_authorities_one_default`); 0016 adds none.

It extends `certificate_authorities` (hierarchy, key algorithm, subject DN, path
length, key source, CRL settings, pending CSR) and `issued_certificates`
(application, profile, source, enrollment method, metadata, algorithms,
fingerprint, chain, renewal links, auto-renew, revocation), and adds the tables
enumerated in plan §4.1. New status values on `issued_certificates` are
validated **in Rust**, not by a SQL `CHECK`, because the applied `0013`
constraint must not be rewritten — migrations are append-only.

Seal scopes, one per secret purpose, alongside the existing
`certificate_authority` and `certificate_delivery`: `managed_leaf_key`,
`enrollment_secret`, `eab_secret`, `est_passphrase`, `scep_static_secret`,
`signer_key`, `hsm_pin`, `external_ca_credential`, `crl_der`,
`acme_account_key`.

No certificate-manager configuration knob has been added to
`crates/gateway/src/config.rs` or `.env.schema` yet; any that is added follows
the env-spec pattern (`@type` / `@required` / `@sensitive` / `@public`
annotations). No live secret is committed.

- Migration applies from empty: _pending: fill from the run of
  `cargo +1.88.0 test -p opensesame-storage`._
- `.env.schema` knobs added: none.

## Standards and dependencies

The table is the scope the full design claims. In this checkout the engine
(`opensesame-pki-core`) implements RFC 5280 issuance and CRL v2 build/verify,
RFC 6960 request and response build/verify, RFC 7468 PEM, RFC 7292 PKCS#12 and
the PKCS#7 `certs-only` format EST uses; the Host serves RFC 7030 EST and the
RFC 8555 ACME *client* (DNS-01). The ACME server, the SCEP server, the CRL and
OCSP endpoints, the PKCS#11 client and provider, and CloudEvents webhooks are
not implemented.

| Standard | Scope claimed here |
|---|---|
| RFC 5280 | X.509 v3 issuance and CRL v2 generation, `CRLReason` codes, CDP/AIA extensions |
| RFC 8555 | ACME client (DNS-01 only, unchanged from ADR 0052-cert) and ACME server (HTTP-01 or skip-validation, mandatory EAB) |
| RFC 7030 | EST server: `cacerts`, `simpleenroll`, `simplereenroll` |
| RFC 8894 | SCEP server: `GetCACaps`, `GetCACert`, `PKIOperation`; static and dynamic challenges |
| RFC 6960 | OCSP responder, CA-direct or delegated signing |
| RFC 7468 | PEM textual encodings for certificates, chains and CSRs |
| RFC 7292 | PKCS#12 build (password-encrypted) and parse (multi-entry enumeration) |
| PKCS#11 v2.40 | HSM client (`cryptoki`) and the sign-only provider module |
| CloudEvents 1.0 | Webhook alert payload envelope |

These are the **profiles OpenSesame implements**, not conformance claims.
Per `docs/reference/protocol-conformance.md`, passing the repository's suites establishes
this implementation profile only; it is not certification, and no certification
is claimed from repository evidence.

Dependencies in use: `rcgen` 0.13 and `x509-parser` 0.16 (`pki-core` and the
gateway, already vetted in the ADR 0052-cert stack), the RustCrypto `der` 0.7
generation and `p12-keystore` (`pki-core`), and `instant-acme = 0.8.5`
exact-pinned (the ACME client, gateway). `cryptoki` (HSM client), `kube` and
`k8s-openapi` (Kubernetes issuer) are not dependencies of any crate in this
checkout; ADR 0071 and ADR 0072 would add them. The planned syncs and external
adapters would send third-party egress through
`ConnectionBroker::authorized_json` (ADR 0048 D5). `pnpm audit:daemon-deps` must
stay green: none of `cryptoki`, `kube`, or `k8s-openapi` may reach a
daemon-adjacent tree.

- Dependency review date and findings: _pending: record at integration time,
  with the output of `pnpm audit:cargo-audit` and `pnpm audit:osv`._

## Security findings and regression proof

Enforcement boundaries and their anchors. Rows whose anchor is "none yet" name
a boundary of a component that does not exist in this checkout, so nothing proves
it:

| Boundary | Anchor |
|---|---|
| Sealed custody, redacting `Debug`, no `Clone`/`Serialize` on secret carriers | `crates/pki-core` secret-carrier types (`KeyPair`, `GeneratedCa`, `SealedKeySigner`, `Pkcs12Entry`); `crates/storage` sealed-carrier tests |
| Cross-organization isolation on every new table | `certmgr_rows_are_isolated_between_organizations` (`crates/storage/src/tests.rs`) and `given_two_organizations_each_with_a_certificate_when_one_lists_then_the_other_is_never_returned` (`crates/storage/tests/certmgr_behavior.rs`); route-level `adversarial_*_another_organization*` tests in `routes/certmgr_ca.rs`, `certmgr_policy.rs` and `certmgr_profile.rs`; modeled on `adversarial_ephemeral_history_isolated_between_organizations` in `crates/gateway/src/routes/certs_tests.rs` |
| Owner/admin gate before any `st.db` access on the authority, policy and profile routes | `require_configurator` in `routes/certmgr_ca.rs` and `routes/certmgr_policy.rs`; application and signer role gates: none yet (no `certmgr_roles.rs`) |
| Another organization's object is a 404, not a 403 | the `adversarial_*_another_organization*` tests above |
| ACME nonce single-use | `chaos_exactly_one_task_consumes_an_acme_nonce` (`crates/storage/tests/certmgr_chaos.rs`), at the store only; ACME server, account-bound order lookup and mandatory EAB: none yet |
| SCEP challenge single-use | `chaos_exactly_one_task_consumes_a_scep_challenge` and `given_a_scep_challenge_already_consumed_...` (`crates/storage/tests/certmgr_chaos.rs`, `certmgr_behavior.rs`), at the store only; SCEP server, bounded expiry and pending set: none yet |
| Revoked serial appears in CRL and OCSP; unrelated serial reads `good`; unknown serial reads `unknown` | `crates/pki-core` revocation tests (`a_revoked_serial_appears_in_the_crl_and_ocsp_agrees_on_the_reason`, `adversarial_a_serial_the_authority_never_issued_is_unknown_not_good`) |
| Tampered CRL or OCSP response fails verification | `crates/pki-core` revocation tests (`adversarial_a_tampered_crl_fails_verification`, `adversarial_a_tampered_response_fails_verification`). A delegated responder signs with its own key (`a_delegated_responder_signs_with_its_own_key`), but the library does not check that the delegate was issued by the CA or carries `id-kp-OCSPSigning`; ADR 0067 §6 puts that check at configuration time, and no configuration path exists |
| EST authenticates every enrollment; a policy-violating CSR is refused whole | `enrollment_without_valid_credentials_is_refused_with_basic_auth` (`routes/est_server_tests.rs`); the refusal is `est_enrollment::decide`, whose `policy_denied` code is pinned in `routes/est_enrollment_tests.rs` — no route-level test drives a violating CSR yet |
| Signing scope pin mismatch denies and ledgers; credential arguments redacted before write | none yet (no Sign API) |
| Signature counter increments atomically under concurrency | `chaos_signature_cap_holds_under_a_racing_swarm` (`crates/storage/tests/certmgr_chaos.rs`), at the store only |
| Sync key material never reaches a caller or a log | none yet (no sync adapter) |
| Agent surfaces carry no secret-bearing tool | `assertsNoSecretTools`, `assertsNoSecretNames`, registry parity suites |

- Codex Security targeted review: _pending. Record CLI and plugin versions,
  base/head SHAs, scoped `--path` boundaries, model and effort, cost cap and
  actual cost, completed/total files from
  `artifacts/02_discovery/work_ledger.jsonl`, findings, and residual unreviewed
  scope. Per `AGENTS.md` §6, never start a bare repository-wide scan._

## Validation results

Global gate — all _pending: fill from the run of each command_:

| Command | Result |
|---|---|
| `pnpm verify` | _pending_ |
| `cargo +1.88.0 test --workspace --all-targets` | _pending_ |
| `pnpm test:coverage` (TS floors 94/88/94/95 + 50% per-package lines; Rust 69/67 lines/functions) | _pending_ |
| `pnpm audit:clippy` | _pending_ |
| `pnpm audit:semgrep` | _pending_ |
| `pnpm audit:cargo-audit` | _pending_ |
| `pnpm audit:gitleaks` | _pending_ |
| `pnpm audit:daemon-deps` | _pending_ |
| `pnpm generate:openapi` (must produce no tracked diff) | _pending_ |

Parity suites that must stay green — _pending: fill from the run of
`pnpm test`_:

`packages/capability-registry/src/registry.test.ts`,
`packages/mcp-host/src/registry-parity.test.ts`,
`packages/mcp-client/src/registry-parity.test.ts`,
`apps/pages/src/webmcp/registry-parity.test.ts`,
`apps/cli/tests/capability_parity.rs`,
`packages/cli/src/capability-parity.test.ts`,
`tests/redteam/src/structural.pact.test.ts`.

### Measured results — foundation crates

Recorded from actual runs on 2026-08-30. Every figure below was produced by the
named command; nothing here is written from expectation. They were not
re-measured for this revision, and the suites have grown since: `crates/storage`
now holds about 380 test functions by source count against the 87 recorded for
the storage run, and `opensesame-pki-core` has 9 `insta` snapshots.

| Crate | `cargo test` | Tests | Lines | Functions | Regions |
|---|---|---|---|---|---|
| `opensesame-pki-core` | exit 0 | 156 | **97.91 %** (4061, 85 missed) | **98.81 %** (337, 4 missed) | 95.68 % |
| `opensesame-storage` | exit 0 | 87 | **91.75 %** (8388, 692 missed) | **88.60 %** (693, 79 missed) | 89.19 % |

Both are far above the workspace floors the Rust coverage gate enforces
(`--fail-under-lines 69 --fail-under-functions 67`), so they raise the workspace
average rather than drawing on its headroom.

Per-file coverage of the security-critical modules — these are the files where a
surviving mutant is a security defect rather than a style nit. `policy.rs`,
`revocation.rs`, `bundle.rs` and `crates/storage/src/lib.rs` are registered in the
mutation gate (`pnpm test:mutation:rust`); `x509.rs` is not:

| File | Lines | Functions |
|---|---|---|
| `crates/pki-core/src/policy.rs` (issuance decisions) | 98.02 % | 98.65 % |
| `crates/pki-core/src/revocation.rs` (CRL/OCSP) | 96.76 % | 96.49 % |
| `crates/pki-core/src/bundle.rs` (chain + PKCS#12 trust) | 97.77 % | 100.00 % |
| `crates/pki-core/src/x509.rs` (untrusted-input parsing) | 95.60 % | 100.00 % |
| `crates/storage/src/lib.rs` (single-use, caps, CAS) | 91.75 % | 88.60 % |

### Mutation testing — measured, and what it caught

`cargo mutants` on `crates/pki-core/src/policy.rs`, shard 1/12 (13 of 154
mutants; the full file could not be run in this environment, see the limits
below):

| Run | Caught | Missed | Unviable |
|---|---|---|---|
| Before | 11 | **1** | 1 |
| After the fix | **12** | 0 | 1 |

The survivor was `policy.rs:365: replace && with || in check_dc`, in a file
measuring 98.02 % line coverage — the gap line coverage cannot see. The `dc`
sequence check is a length equality *and* a zipped per-component match; `zip`
stops at the shorter sequence, so the length test is what makes the comparison
total. Without it a subject that merely extends an allowed sequence
(`dc=corp,example,com` under a policy permitting only `corp,example`) satisfies
the zipped comparison and is issued — a certificate for an organizational
subtree the policy never granted, which is precisely what ordered `dc` matching
exists to prevent.

The pre-existing case did not catch it because its first components already
disagreed, so the prefix comparison failed on its own and both operators
behaved identically. `adversarial_dc_prefix_agreement_is_not_a_match` pins the
length check in both directions, confirms the exact sequence is still accepted,
and confirms a wildcard matches one component rather than an arbitrary number.
The mutation run was repeated after the fix to prove the test *kills* the
mutant rather than merely passing beside it.

**Environment limit:** a full-file run exhausted the session disk allowance
(`No space left on device` after generating all 154 mutants), and
`cargo-mutants` is not installed in a default checkout. The sharded run above is
a real sample, not a full-file score; the remaining shards are unmeasured.

Test types delivered per crate (plan §6.0):

| Crate | unit | snapshot | pact | chaos | behavior | property | fuzz |
|---|---|---|---|---|---|---|---|
| `opensesame-pki-core` | ✓ | ✓ (9 `insta`) | ✓ | ✓ | ✓ | ✓ | targets registered |
| `opensesame-storage` | 36 | 4 | 9 | 6 | 4 | 2 | 1 target |

`cargo-llvm-cov` is not present in a default checkout of this environment and
was installed to take these measurements (`cargo install cargo-llvm-cov
--locked`); a reader reproducing them needs it too.

Per-crate and per-package done-commands — _pending each_:

`cargo +1.88.0 test -p opensesame-pki-core`,
`cargo +1.88.0 test -p opensesame-storage`,
`cargo +1.88.0 test -p opensesame-gateway`,
`cargo +1.88.0 test -p opensesame-cli`,
`pnpm --filter @opensesame/capability-registry test`,
`pnpm --filter @opensesame/mcp-host test`,
`pnpm --filter @opensesame/api-client test`,
`pnpm --filter @opensesame/pages test`.

Depth gates:

- TypeScript coverage: _pending: fill from the run of `pnpm test:coverage:ts`._
- Rust coverage: _pending: fill from the run of `pnpm test:coverage:rust`._
- TypeScript mutation: _pending: fill from the run of `pnpm test:mutation:ts`._
- Rust mutation: _pending: fill from the run of `pnpm test:mutation:rust`._
- Fuzz — certificate-manager targets registered in `tests/fuzz/cargo/Cargo.toml`:
  `certmgr_filter_parse`, `pki_csr_parse`, `pki_pkcs12_parse`, `pki_crl_parse`,
  `pki_ocsp_request_parse` (no SCEP CMS or ACME JWS target exists, as neither
  server does). Executions and duration:
  _pending: fill from the run of `pnpm audit:fuzz` (short pass) and
  `pnpm audit:fuzz:batch`._
- Kani / Miri / Shuttle: not extended to `opensesame-pki-core` or the
  certificate-manager storage code; `scripts/audit/kani-gate.sh`,
  `miri-gate.sh` and `shuttle-gate.sh` name other crates (see
  [fuzzing.md](fuzzing.md)).

**No number in this document may be written from expectation.** A gate that has
not been run stays `_pending_`.

## Validation limits — what CI actually proves, per area

This table is reproduced from plan §6. Read it as the ceiling on every claim
above. Rows for the ACME server, SCEP, external CA adapters, the HSM client, the
PKCS#11 provider, the Windows KSP, the Kubernetes issuer and the sync executors
describe planned depth: those components are not in this checkout.

| Area | Validation depth in CI |
|---|---|
| PKI engine, policy, CRL, OCSP, revocation | Full unit + property + fuzz, hermetic |
| CA management, inventory, applications, approvals, renewal, alerts, discovery | Full unit + contract + adversarial, hermetic (in-process listeners / fixtures) |
| ACME server, EST, SCEP | Hermetic interop (in-crate client / recorded fixtures) |
| External CA adapters | Recorded-fixture contract tests only — no live third-party calls |
| HSM client | SoftHSM2 integration if present, else mock-token unit test (recorded skip) |
| PKCS#11 provider cdylib | Builds + unit tests against a Sign API double |
| Windows KSP | Build-only cross-compile (or a documented compile guard if the target toolchain is absent) |
| K8s issuer | Reconcile against a `kube` fake client — no live cluster |
| Sync SSH/WinRM executors | Feature-gated, unit-tested against fakes |

Which Windows KSP variant applied: none — no Windows KSP crate exists in this
checkout, so there is no cross-compile or compile guard to state.

## Residual risk and intentionally unsupported profiles

Items 1–11 belong to components that are not implemented in this checkout
(external CA adapters, the HSM client, the Windows KSP, the Kubernetes issuer,
the Sign API, the ACME and SCEP servers, syncs, CRL generation); they state the
risk the design accepts once those components exist. Item 13 is partly
implemented.

1. **External CA adapters are fixture-validated only.** AWS PCA, DigiCert,
   Sectigo, GoDaddy, Azure ADCS, Venafi Cloud and private-ACME adapters (named
   as `external_ca_configs` kinds in the schema; no adapter exists yet) would be
   exercised against recorded request/response fixtures. A provider that changes
   its API breaks in production before it breaks in CI. Live provider validation
   is an operational obligation of onboarding.
2. **HSM support is validated against SoftHSM2, not hardware.** A green suite
   proves PKCS#11 API correctness — call sequences, session and object
   lifetimes, mechanism parameters, error handling. It proves nothing about any
   particular appliance's mechanism support, threading behavior, session limits
   or attribute-template strictness. Operator acceptance testing against the
   specific module is required (ADR 0071 §6).
3. **The Windows KSP is build-only.** It has never been loaded by `signtool` on
   a Windows host in CI. "It compiles for Windows" is the entire claim
   (ADR 0070 §5).
4. **No live-cluster Kubernetes end-to-end test.** The controller is reconciled
   against a `kube` fake client. Its interaction with a genuine cert-manager
   release is unvalidated by our gates (ADR 0072 §5).
5. **The Sign API signs a digest it did not compute.** OpenSesame cannot know
   what bytes a digest covers. Scope pinning constrains the circumstances of a
   signature, not its subject (ADR 0070 §2).
6. **Scope-pin fields other than `ip` are client-asserted.** A fully compromised
   signing host can forge command, application name, application SHA-256,
   hostname and OS username. `ip` is server-observed and is trustworthy **only**
   behind a correctly configured trusted-proxy setting; misconfigured, it
   degrades to client-asserted (ADR 0070 §3).
7. **ACME skip-validation issues without proving control of the identifier.**
   It is admin-enabled per profile, never a fallback, and audited — but a
   profile in skip mode is only as strong as its EAB secret and its policy
   constraints (ADR 0068 §3).
8. **SCEP's protocol cryptography is dated by design.** We implement RFC 8894
   faithfully rather than inventing a hardened variant. Static challenges are a
   fleet-wide shared secret; prefer dynamic challenges (ADR 0068 §4).
9. **Syncs move private keys off this system on a schedule, without a human
   present.** This is the most sensitive path in the subsystem. It is fenced by
   broker egress, admin-only configuration, no caller-visible key path, and
   agent-surface exclusion — and it remains a deliberate risk accepted under
   ADR 0069 §2.
10. **`crl_number` monotonicity is a forward-only database invariant.**
    Restoring an older database backup can move it backwards and let a relying
    party reject the current CRL as stale. The operator runbook must treat CRL
    state as forward-only (ADR 0067 §Consequences).
11. **HSM-held keys cannot be backed up by OpenSesame.** ADR 0039's snapshot path
    covers sealed keys only. Hardware key ceremony, backup and disaster recovery
    are the operator's, through their module (ADR 0071 §Consequences).
12. **Excluded, with rationale in ADR 0066 §Non-goals:** ML-DSA post-quantum CAs
    (roadmap — no ML-DSA X.509 path in the pinned stack); Microsoft ADCS via
    MS-WCCE/NTLM (excluded — DCOM/RPC transport); SCEP Intune challenge
    validation (roadmap — requires a live Microsoft Graph tenant); cloud and
    filesystem discovery (roadmap); a Terraform provider (excluded — REST/CLI/MCP
    are the IaC surfaces under ADR 0065); KMS/KMIP/SSH-CA/PAM (out of
    Certificate Manager scope).
13. **Upstream HTTP-01 and TLS-ALPN-01 remain refused** as an ACME client
    (ADR 0068 §6). The design rule that registering a private upstream ACME
    directory yields trust class `private_local` and never `public_web` has no
    implementation yet: there is no registration route.
14. **This document claims the documented subsets** of RFC 5280, 8555, 7030,
    8894, 6960, 7468, 7292 and PKCS#11 v2.40 — not general CA, WebPKI, browser,
    hardware, NIST or provider conformance.

## Evidence paths

- Domain model: [`docs/adr/0066-certificate-manager-domain-model.md`](../adr/0066-certificate-manager-domain-model.md)
- Revocation: [`docs/adr/0067-certificate-revocation-crl-ocsp.md`](../adr/0067-certificate-revocation-crl-ocsp.md)
- Enrollment servers: [`docs/adr/0068-enrollment-protocol-servers.md`](../adr/0068-enrollment-protocol-servers.md)
- Syncs: [`docs/adr/0069-certificate-syncs.md`](../adr/0069-certificate-syncs.md)
- Code signing: [`docs/adr/0070-code-signing.md`](../adr/0070-code-signing.md)
- HSM connectors: [`docs/adr/0071-hsm-connectors.md`](../adr/0071-hsm-connectors.md)
- Kubernetes issuer: [`docs/adr/0072-kubernetes-external-issuer.md`](../adr/0072-kubernetes-external-issuer.md)
- Predecessor issuance decision:
  [`docs/adr/0052-automatic-certificate-authority-selection.md`](../adr/0052-automatic-certificate-authority-selection.md)
- Predecessor evidence:
  [`docs/validation/automatic-certificate-issuance.md`](automatic-certificate-issuance.md)
- Threat model: [`docs/security/threat-model.md`](../security/threat-model.md)
- Key hierarchy: [`docs/security/key-hierarchy.md`](../security/key-hierarchy.md)
- Standards matrix: [`docs/reference/standards-matrix.md`](../reference/standards-matrix.md)
- Conformance stance: [`docs/reference/protocol-conformance.md`](../reference/protocol-conformance.md)
