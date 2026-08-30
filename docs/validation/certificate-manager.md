# Certificate Manager implementation evidence

Status: **evidence template — implementation in flight.** The delivered-behavior,
schema, standards, and limitation sections below are written from the committed
plan and from ADRs 0066–0072. Every **numeric** result — coverage, mutation,
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
  [`docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md`](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md).
- Integration base commit: _pending: fill from `git rev-parse origin/main` at
  integration time._
- Implementation head: _pending: fill from `git rev-parse HEAD` at integration
  time._
- Toolchain: Rust 1.88 (`cargo +1.88.0`), Node ≥ 22, pnpm 9.15.0, Turbo 2.9.14,
  Biome 1.9.4, Vitest 4.1.10, Playwright 1.55.1 — as pinned in `AGENTS.md` §2.

## Delivered behavior

### Domain model (ADR 0066)

Certificate management walks one object chain: certificate authority → policy →
profile → application → enrollment config → certificate. Policies are pure
constraint documents with three-state field rules; profiles bind a CA, a policy
and defaults; applications are service workspaces whose members hold
`admin`/`operator`/`auditor` roles layered over the existing caller model in
`apps/gateway/src/middleware/auth.rs`. Inventory rows carry a `source` of
`issued`, `imported` or `discovered`, and renewal is a bidirectional link
(`renewed_from_id` / `renewed_by_id`), one renewal per certificate, with custom
metadata carried across. Every mutating `/api/v1/certmgr/*` route appends a
`certmgr.<object>.<verb>` outbox audit event in the same transaction as its state
change.

The existing `/api/v1/certs/*` routes are unchanged and remain the
zero-configuration issuance path.

### Certificate authorities

Root and intermediate CAs with path-length constraints and full DN fields; key
algorithms RSA-2048, RSA-4096, ECDSA P-256, ECDSA P-384 (Ed25519 for leaves);
externally-signed intermediates via CSR export and signed-chain import; CA
renewal in both same-key and new-key modes, with previously issued certificates
remaining valid across a new-key renewal.

### Revocation (ADR 0067)

Revocation writes an immutable record with an RFC 5280 `CRLReason` code. CRL v2
is generated per CA with a monotonic `cRLNumber`, signed by the issuing CA
through the custody-agnostic `Signer` trait, regenerated on revoke and on the
`next_update` horizon by the lifecycle actor, coordinated only through the
`crl_state` row. Newly issued internal-CA certificates embed a CRL Distribution
Point; up to four additional mirror URLs may be advertised (advertise-only — the
operator republishes). CRL DER is sealed at rest under the `crl_der` scope.
`GET /crl/{caId}.crl`, `GET /crl/{caId}.pem` and the RFC 6960 OCSP responder at
`/ocsp/{caId}` are unauthenticated by design and contract-allowlisted with a
category comment. The responder signs with the CA key or an explicitly delegated
OCSP-signing certificate carrying `id-kp-OCSPSigning` and issued by that same CA.

### Enrollment protocols (ADR 0068)

Server side, profile-scoped: ACME (RFC 8555) with mandatory per-profile EAB,
single-use nonces, HTTP-01 validation or an admin-enabled skip-validation mode;
EST (RFC 7030) `cacerts` / `simpleenroll` / `simplereenroll` with passphrase,
bootstrap-chain and mTLS authentication; SCEP (RFC 8894) `GetCACaps` /
`GetCACert` / `PKIOperation` with static and one-time dynamic challenges.

Client side: upstream HTTP-01 and TLS-ALPN-01 remain refused (ADR 0052-cert's
rationale restated — DNS-01 is a strict superset). Organization administrators
may register private ACME directories, which receive trust class
`private_local` assigned in code; `public_web` remains pinned to the code-owned
registry in `apps/gateway/src/cert_issuers/registry.rs`.

### Lifecycle, discovery, alerting, approvals

Auto-renewal and manual renewal with copy-on-write semantics and a per-issuer
key-handling matrix; certificate cleanup N days past expiry skipping
certificates with active syncs; network TLS discovery jobs (≤20 domains, ≤256
IPs, CIDR ≥ /24, ≤5 ports) tracking installations by SHA-256 fingerprint across
scans; expiration/issuance/renewal/revocation alerts over email, Slack,
PagerDuty Events v2 and CloudEvents 1.0 webhooks with HMAC-SHA256 signatures;
multi-step M-of-N approval workflows with max-request-TTL and machine-identity
bypass.

### Code signing (ADR 0070)

Signers are authority handles fulfilling ADR 0005's `SignerRef`, with **no key
read path of any kind** — not even a human ceremony. The Sign API takes a
precomputed digest and returns a signature; it never accepts an artifact.
Approvals pin any subset of command, application name, application SHA-256,
hostname, OS username, server-observed IP and data hash, and become immutable
access records with signature counters and signing windows. A PKCS#11 v2.40
sign-only provider module (`cdylib`) proxies to the Sign API over the daemon
socket; a Windows CNG KSP is build-only. Every attempt — succeeded, failed or
denied — appends to the per-signer activity ledger with credential arguments
redacted at write time.

### HSM connectors (ADR 0071)

PKCS#11 client over `cryptoki`; connectors carry a slot **label** (never an
index), a sealed PIN with no read path, and an optional key-label prefix.
Mechanisms: RSA PKCS#1 v1.5 (raw and SHA-256/384/512) and ECDSA
SHA-256/384/512; key generation RSA-2048/4096 and P-256/P-384. Verify-on-create
performs a live sign-and-verify round trip. PIN rotation touches only the
connector row. HSM-held keys implement the same `Signer` trait as sealed keys,
so CA, CRL, OCSP and signing code is custody-agnostic.

### Syncs (ADR 0069)

Certificate syncs push a certificate, its chain and where applicable its private
key to administrator-configured destinations through
`ConnectionBroker::authorized_json`. Key material is unsealed only inside the
sync actor pass and is never returned to any caller. Every push emits an outbox
audit event and a `sync_runs` record. SSH and WinRM executors are cargo-feature
gated and default-off, following ADR 0053. `certmgr.sync.*` is excluded from
every agent surface.

### Kubernetes issuer (ADR 0072)

`apps/k8s-issuer` is a kube-rs controller exposing `Issuer` and `ClusterIssuer`
CRDs in group `certmgr.opensesame.dev`, reconciling cert-manager
`CertificateRequest`s against the API-enrollment route with machine-identity
authentication and surfacing the issuing chain in `ca.crt`. The ACME server
remains the zero-install path for the stock cert-manager ACME issuer.

## Schema and configuration

`migrations/0016_certificate_manager.sql` follows the conventions of the applied
`migrations/0013_certificate_issuance.sql`: `TEXT` primary keys, RFC3339 `TEXT`
timestamps, `organization_id TEXT NOT NULL REFERENCES organizations(id)`,
composite `UNIQUE(organization_id, id)`, optimistic `version` on mutable rows,
partial unique indexes for one-default-per-organization, and all-or-nothing
`CHECK` groups on sealed-blob column sets
(`*_key_id`, `*_ciphertext`, `*_nonce`, `*_aad_digest`).

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

New configuration knobs are `pub fn`s in `apps/gateway/src/config.rs` and are
documented in `.env.schema` with `@type` / `@required` / `@sensitive` /
`@public` annotations. No live secret is committed.

- Migration applies from empty: _pending: fill from the run of
  `cargo +1.88.0 test -p opensesame-storage`._
- `.env.schema` knobs added: _pending: enumerate after the Assembler wiring
  lands._

## Standards and dependencies

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
Per `docs/protocol-conformance.md`, passing the repository's suites establishes
this implementation profile only; it is not certification, and no certification
is claimed from repository evidence.

Dependencies: `rcgen` and `x509-parser` (already vetted in the ADR 0052-cert
stack), `instant-acme = 0.8.5` exact-pinned (client, and reused as the hermetic
test client against our own ACME server), `cryptoki` (HSM client, gateway only),
`kube` and `k8s-openapi` (Kubernetes issuer only). No new `reqwest` dependent is
introduced (ADR 0048 D5); all third-party egress goes through
`ConnectionBroker::authorized_json`. `pnpm audit:daemon-deps` must stay green:
none of `cryptoki`, `kube`, or `k8s-openapi` may reach a daemon-adjacent tree.

- Dependency review date and findings: _pending: record at integration time,
  with the output of `pnpm audit:cargo-audit` and `pnpm audit:osv`._

## Security findings and regression proof

Enforcement boundaries and their intended anchors:

| Boundary | Anchor |
|---|---|
| Sealed custody, redacting `Debug`, no `Clone`/`Serialize` on secret carriers | `crates/storage` sealed-carrier tests |
| Cross-organization isolation on every new table | storage isolation tests, modeled on `adversarial_ephemeral_history_isolated_between_organizations` in `apps/gateway/src/routes/certs.rs` |
| Application/signer role gates before any `st.db` access | forthcoming `apps/gateway/src/routes/certmgr_roles.rs` tests |
| Non-member sees 404, not 403 | `certmgr_app.rs` inline tests |
| ACME nonce single-use; account-bound order lookup | `acme_server.rs` hermetic e2e |
| EAB mandatory on `new-account` | `acme_server.rs` inline tests |
| SCEP dynamic challenge single-use, bounded expiry and pending set | `scep_server.rs` fixture interop tests |
| Revoked serial appears in CRL and OCSP; unrelated serial reads `good`; unknown serial reads `unknown` | `crates/pki-core` revocation tests |
| Tampered CRL fails verification; OCSP signed only by CA or valid delegate | `crates/pki-core` revocation tests |
| Signing scope pin mismatch denies and ledgers | `certmgr_signers.rs` inline tests |
| Signature counter increments atomically under concurrency | `certmgr_signers.rs` concurrency test |
| Credential arguments redacted before write | `certmgr_signers.rs` redaction tests |
| Sync key material never reaches a caller or a log | `cert_syncs` adapter tests |
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
`apps/mcp-host/src/registry-parity.test.ts`,
`apps/mcp-client/src/registry-parity.test.ts`,
`apps/pages/src/webmcp/registry-parity.test.ts`,
`apps/pwa/src/webmcp.test.ts`,
`apps/cli/tests/capability_parity.rs`,
`packages/cli/src/capability-parity.test.ts`,
`packages/redteam/src/structural.pact.test.ts`.

Per-crate and per-package done-commands — _pending each_:

`cargo +1.88.0 test -p opensesame-storage`,
`cargo +1.88.0 test -p opensesame-pki-core`,
`cargo +1.88.0 test -p opensesame-gateway`,
`cargo +1.88.0 test -p opensesame-cli`,
`cargo +1.88.0 build -p opensesame-hsm-client`,
`cargo +1.88.0 build -p opensesame-pkcs11-provider`,
`cargo +1.88.0 build --target x86_64-pc-windows-gnu -p opensesame-windows-ksp`,
`cargo +1.88.0 test -p opensesame-k8s-issuer`,
`pnpm --filter @opensesame/capability-registry test`,
`pnpm --filter @opensesame/mcp-host test`,
`pnpm --filter @opensesame/api-client test`,
`pnpm --filter @opensesame/pages test`.

Depth gates:

- TypeScript coverage: _pending: fill from the run of `pnpm test:coverage:ts`._
- Rust coverage: _pending: fill from the run of `pnpm test:coverage:rust`._
- TypeScript mutation: _pending: fill from the run of `pnpm test:mutation:ts`._
- Rust mutation: _pending: fill from the run of `pnpm test:mutation:rust`._
- Fuzz — new targets registered in `fuzz/Cargo.toml`: CSR parser, PKCS#12
  parser, SCEP CMS parser, ACME JWS parser. Executions and duration:
  _pending: fill from the run of `pnpm audit:fuzz` (short pass) and
  `pnpm audit:fuzz:batch`._
- Kani / Miri / Shuttle: _pending: fill from the runs of `pnpm audit:kani`,
  `pnpm audit:miri`, `pnpm audit:shuttle` if these gates are extended to the new
  crates; state explicitly if they are not._

**No number in this document may be written from expectation.** A gate that has
not been run stays `_pending_`.

## Validation limits — what CI actually proves, per area

This table is authoritative and is reproduced from plan §6. Read it as the
ceiling on every claim above.

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

Which Windows KSP variant applied in this run: _pending: state whether the
`x86_64-pc-windows-gnu` cross-compile ran, or whether it degraded to the
`#[cfg(target_os = "windows")]` compile guard._

## Residual risk and intentionally unsupported profiles

1. **External CA adapters are fixture-validated only.** AWS PCA, DigiCert,
   Sectigo, GoDaddy, Azure ADCS, Venafi Cloud and private-ACME adapters are
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
    (ADR 0068 §6). Registering a private upstream ACME directory yields trust
    class `private_local` and never `public_web`.
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
- Standards matrix: [`docs/standards-matrix.md`](../standards-matrix.md)
- Conformance stance: [`docs/protocol-conformance.md`](../protocol-conformance.md)
