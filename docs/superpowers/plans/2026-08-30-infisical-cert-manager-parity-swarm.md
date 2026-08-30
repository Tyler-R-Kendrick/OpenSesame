# Certificate Manager parity — swarm implementation prompt

Date: 2026-08-30
Branch: any feature branch off `main`; one PR per swarm is acceptable, one umbrella PR is not required.
Audience: an orchestrating LLM agent that dispatches the subagent swarms specified in §5. Every
swarm spec is self-contained: it names its owned files, its wire contracts, its tests, and its
done-command. **No swarm may need this conversation, external URLs, or another swarm's chat
context to do its work** — everything required is in this document plus the repository itself.

---

## 1. Mission and operating rules

### 1.1 Mission

Close the competitive gap between OpenSesame's certificate capability and Infisical's
Certificate Manager product, at maximum scope: CA hierarchy management, certificate policies and
profiles, applications with role-scoped membership, four enrollment methods (API, ACME server,
EST, SCEP), a real certificate inventory with import/export, revocation with CRL and OCSP,
auto/manual renewal, network TLS discovery, lifecycle alerting, multi-step approvals, a full
code-signing subsystem (signers, Sign API, PKCS#11 provider module, scoped signing approvals),
certificate syncs to external destinations, HSM connector plumbing, a Kubernetes cert-manager
external issuer, and a Certificates dashboard UI — implemented in OpenSesame's existing
architecture, passing `pnpm verify` and `cargo +1.88.0 test --workspace --all-targets`.

### 1.2 What already exists (do not rebuild; extend)

The ADR 0052 certificate stack is live and is the substrate for everything below:

| Existing piece | Location |
|---|---|
| Private dev CA (ECDSA P-256, self-signed root, `issue_leaf`) | `apps/gateway/src/dev_pki.rs` |
| Issuance domain model (`CertificateRequest`, `IssuedCertificate`, `IssuerKind`, `TrustClass`, `normalize_external_certificate`) | `apps/gateway/src/cert_issuers/model.rs` |
| ACME **client** (RFC 8555, DNS-01 only, `instant-acme`, EAB) | `apps/gateway/src/cert_issuers/acme.rs` |
| Cloudflare DNS-01 provisioner + Origin CA issuer | `apps/gateway/src/cert_issuers/cloudflare_dns.rs`, `cloudflare_origin.rs` |
| External issuer registry (Let's Encrypt / ZeroSSL / Cloudflare Origin), data-driven DNS shapes, broker-fenced DNS calls | `apps/gateway/src/cert_issuers/registry.rs` |
| HTTP surface: `GET /api/v1/certs`, `GET /api/v1/certs/ca`, `POST /api/v1/certs/issue`, `POST /api/v1/certs/deliveries/{id}/ack` | `apps/gateway/src/routes/certs.rs`, wired in `routes/mod.rs` |
| Persistence: `certificate_authorities`, `certificate_issuance_requests`, `issued_certificates` | `migrations/0013_certificate_issuance.sql`, `crates/storage/src/lib.rs` |
| Sealed key custody (XChaCha20-Poly1305, purpose-scoped AAD) | `crates/connection-broker/src/crypto.rs` (`seal_scoped`, `open_with_ad`) |
| CLI verbs `opensesame cert ca|issue|ls` | `apps/cli/src/certs.rs` |
| MCP tools `cert_read`, `cert_issue` (Zod-projected, key material fenced) | `apps/mcp-host/src/tools-read.ts`, `tools-act.ts` |
| Pages issuance UI + `certificate` vault item kind | `apps/pages/src/lib/certs.ts`, `src/sections/vault/ItemEditor.tsx` |
| Capability entries `certs.list`, `certs.issue`, `certs.ca` | `packages/capability-registry/src/index.ts` |

The existing `/api/v1/certs/*` routes stay as-is (backward compatible). All new management
surface lives under `/api/v1/certmgr/*`; enrollment-protocol endpoints live at `/acme/*`,
`/.well-known/est/*`, `/scep/*`, `/crl/*`, `/ocsp/*` as specified in §4.2.

### 1.3 Global invariants (every swarm, non-negotiable)

1. **Sealed custody.** Private keys (CA, leaf managed-key, signer, HSM PINs, EST/SCEP/EAB
   secrets) are sealed at rest with `seal_scoped(key, SCOPE, id, organization, plaintext)` from
   `opensesame_connection_broker::crypto`, each with its own scope constant (§4.5). Secret-bearing
   Rust types do not implement `Clone`/`Serialize`; `Debug` is redacted (follow
   `SealedCertificateMaterial` in `crates/storage/src/lib.rs:37`).

   **Where private keys may live is itself an invariant.** `issued_certificates` holds public
   material only — ADR 0052 gives a leaf key to its holder exactly once, through the sealed,
   expiring, single-use delivery that is nulled after collection, and the pre-existing test
   `atomic_certificate_delivery_is_encrypted_expiring_and_single_use` in `crates/storage` asserts
   no column there matches `private`/`ciphertext`/`nonce`. Persistent managed-key custody, which
   server-driven renewal and syncs require, lives **only** in `managed_certificate_keys` (§4.1).
   No certificate read path may join it. Do not widen an existing table to hold key material and
   do not modify that test: if a feature seems to need persistent key custody somewhere new, that
   is a decision requiring its own ADR, not a schema change.
2. **No key material to agent surfaces.** MCP/WebMCP responses pass through Zod projection
   schemas; `assertsNoSecretTools` (`apps/mcp-host/src/tools.ts`) and
   `assertsNoSecretNames` (`packages/capability-registry`) must keep passing. Export/reveal
   operations are human-ceremony surfaces (CLI `--reveal`/`--out-dir`, Pages UI) only.
3. **Request hygiene.** Every request body struct: `#[derive(Deserialize)] #[serde(deny_unknown_fields)]`.
   Every response through a `*_view(...) -> serde_json::Value` whitelist projection. Explicit
   `DefaultBodyLimit::max(...)` per mutating route.
4. **Authz before state.** Every handler starts with a gate built on
   `apps/gateway/src/middleware/auth.rs` (`resolve_caller`, `Caller::can_configure_integrations`)
   or the new application/signer role checks (§5.8), before touching `st.db`.
5. **Org scoping.** All new tables carry `organization_id` with composite
   `UNIQUE(organization_id, id)` and child FKs on the tenant pair, exactly as
   `migrations/0013_certificate_issuance.sql` does. Cross-org reads are adversarially tested
   (model: `adversarial_ephemeral_history_isolated_between_organizations` in `routes/certs.rs`).
6. **Egress through the broker.** All outbound HTTP to third parties (DNS providers, external
   CAs, Slack/PagerDuty/webhooks, sync destinations) goes through
   `ConnectionBroker::authorized_json` so per-connection egress allowlists and credential
   injection apply (model: `BrokeredDns01` in `cert_issuers/registry.rs`). The two exceptions,
   each with its own ADR section: the discovery scanner's raw TLS probe (§5.11) and ACME
   HTTP-01 validation fetches (§5.13), both constrained to the target identifiers of the job/order.
7. **Migrations append-only.** New SQL files `migrations/0016_*.sql` onward, appended to the
   `MIGRATIONS` const in `crates/storage/src/lib.rs:143`. Never edit an applied migration.
8. **Contract tests.** Every new route is either documented in `api/openapi/openapi.yaml` or
   allowlisted with a category comment in `apps/gateway/src/routes/contract.rs`
   (the Assembler swarm, §5.20, owns both files). Consequential routes add an ordering pact in
   `apps/gateway/src/main.rs` `mod pact_coverage` via
   `opensesame_host_core::pact::assert_source_order`.
9. **Capability parity.** Every user-facing capability (route group, CLI verb, Pages action)
   gets a `packages/capability-registry` entry mapping or ADR-excluding each agent surface
   (ADR 0065). Parity suites that must stay green:
   `packages/capability-registry/src/registry.test.ts`, `apps/mcp-host/src/registry-parity.test.ts`,
   `apps/mcp-client/src/registry-parity.test.ts`, `apps/pages/src/webmcp/registry-parity.test.ts`,
   `apps/pwa/src/webmcp.test.ts`, `apps/cli/tests/capability_parity.rs`,
   `packages/cli/src/capability-parity.test.ts`.
10. **House style.** Rust: `//!` module docs naming the ADR and the secrecy invariant;
    `/// # Errors` on fallible pub fns (Clippy pedantic is denied — `pnpm audit:clippy`);
    `tracing` for logs, never `println!`; errors returned as `{"error": "...", "hint": "..."}`
    without leaking internals (`fn internal(...)` pattern in `routes/backup.rs`). TS: Biome
    2-space, Vitest, Zod at boundaries. No `sudo`. No new `reqwest` dependents (ADR 0048 D5).
11. **Config.** New env knobs are `pub fn`s in `apps/gateway/src/config.rs` and documented in
    `.env.schema` with `@type`/`@required`/`@sensitive`/`@public` annotations. Never commit live
    secrets.
12. **Definition of done (global).** `pnpm verify` green, `cargo +1.88.0 test --workspace
    --all-targets` green, `pnpm test:coverage` floors hold (94/88/94/95 TS; 69/67 Rust lines/functions),
    relevant `pnpm audit:*` gates green, and each swarm's own done-commands (§5) pass.

### 1.4 Coordination model (why there are no phases)

Sequencing is replaced by **written contracts**: §4 fully specifies the schema DDL, the route
table, the storage accessor surface, the crate/dependency set, and the capability ID list.
Every swarm codes against §4, not against another swarm's output. Exactly one swarm owns each
file (§7); files that many features touch (`routes/mod.rs`, `app_state.rs`, `main.rs`,
`openapi.yaml`, capability registry source, `hostTools`, `AppShell.tsx`, `.env.schema`) are
owned solely by the Assembler swarm (§5.20), which applies the pre-specified wiring diffs and
drives the final green build. If a swarm discovers a contract defect, it amends §4 in its PR
and says so in the PR body — it never invents an out-of-band interface.

---

## 2. Competitive gap matrix and dispositions

Legend: **BUILD(n)** = built by swarm §5.n. **EXCLUDE** = deliberately not built; rationale
recorded in the named ADR. **KEEP** = existing behavior already at parity.

| # | Infisical Certificate Manager feature | OpenSesame today | Disposition |
|---|---|---|---|
| 1 | Dashboard (totals, active/expiring/expired/revoked, by-enrollment/algorithm/CA charts, expiration timeline, activity trend) | none | BUILD(19b) UI + BUILD(7) rollup route |
| 2 | Inventory: list/filter/columns, detail (subject, extensions, crypto, metadata), statuses incl. `renewed` linkage | list of self-issued certs only | BUILD(7) |
| 3 | Import: PEM and PKCS#12/PFX keystores (multi-entry selection) | none | BUILD(7) + BUILD(3) parser |
| 4 | Export: PEM files, password-encrypted PKCS#12 | PEM at issuance only | BUILD(7) + BUILD(3) |
| 5 | Custom metadata key-values, preserved across renewal, filterable | none | BUILD(7) |
| 6 | Root + intermediate CA hierarchy, path-length constraints, DN fields | single self-signed dev root | BUILD(6) + BUILD(3) |
| 7 | CA key algorithms RSA-2048/4096, ECDSA P-256/P-384 (+ Ed25519 leaf) | P-256 only, hardcoded | BUILD(3) |
| 8 | Post-quantum ML-DSA-44/65/87 CAs | none | EXCLUDE — ADR 0066 §Roadmap: no ML-DSA X.509 path in the pinned `rcgen 0.13`/rustc 1.88 stack; revisit when RustCrypto/aws-lc X.509 ML-DSA stabilizes |
| 9 | Externally-signed intermediates (export CSR → import signed cert), stored signing-config | none | BUILD(6) |
| 10 | CA renewal (same-key; external auto-renew N-days-before) | none | BUILD(6) — plus **new-key renewal**, which Infisical itself lacks |
| 11 | HSM-backed CA/signer keys via PKCS#11 connector | none | BUILD(16) via `cryptoki` + SoftHSM2 validation |
| 12 | CRL: embedded CDP, managed CRL endpoint, up to 4 advertised mirrors, regeneration on revoke/nextUpdate | `CrlSign` key usage set, nothing else | BUILD(5) |
| 13 | OCSP responder | **Infisical lacks this** (CRL only) | BUILD(5) — deliberate differentiator, ADR 0067 |
| 14 | External CA connectors: AWS PCA, DigiCert (ACME-EAB + Direct), Sectigo, GoDaddy, Venafi TLS Protect Cloud | Let's Encrypt/ZeroSSL/Cloudflare Origin only | BUILD(16) as broker-fenced adapters with recorded-fixture contract tests |
| 15 | Microsoft ADCS via MS-WCCE/NTLM gateway | none | EXCLUDE — ADR 0066: MS-WCCE requires a Windows DCOM/RPC stack; the HTTPS web-enrollment adapter (#16) covers the reachable surface |
| 16 | Azure ADCS HTTPS web-enrollment (template discovery, immediate issuance) | none | BUILD(16) |
| 17 | Generic/private ACME upstream directories (client side) | pinned registry only; arbitrary directories refused by ADR 0052 | BUILD(16) — **narrow supersession** (ADR 0068): admin-registered private directories get trust class `private_local`; `public_web` stays code-pinned |
| 18 | Upstream ACME HTTP-01 validation (client side) | refused (DNS-01 only) | EXCLUDE — KEEP refusal, ADR 0068 restates: DNS-01 is a strict superset (wildcards, no inbound :80); Infisical is also DNS-01-only upstream |
| 19 | Certificate Policies: 8 presets, 3-state field rules, subject/SAN/algorithm/KU/EKU/BC constraints | 4 global constants | BUILD(4) |
| 20 | Certificate Profiles: CA+policy+defaults, self-signed issuer type, external template pick | none | BUILD(4) |
| 21 | Applications: per-service workspaces, admin/operator/auditor members (users, machine identities) | none | BUILD(8) |
| 22 | API enrollment: CSR mode + managed-key mode, metadata, approval-aware responses, auto-renew defaults | server-generated key only, no CSR intake | BUILD(8) route + BUILD(3) CSR path |
| 23 | ACME **server** (RFC 8555; Certbot/cert-manager/win-acme clients; HTTP-01 or skip-validation; EAB per profile) | none | BUILD(13) |
| 24 | EST (RFC 7030): cacerts/simpleenroll/simplereenroll, passphrase + bootstrap-chain auth, mTLS re-enroll | none | BUILD(14) |
| 25 | SCEP (RFC 8894): GetCACaps/GetCACert/PKIOperation, static + dynamic one-time challenges, cert-based renewal, RA-cert options | none | BUILD(14) |
| 26 | SCEP Intune challenge validation | none | EXCLUDE — ADR 0066: requires a live Microsoft Graph tenant; the dynamic-challenge webhook endpoint (#25) is the seam an Intune adapter would use |
| 27 | Renewal: server-driven (managed-key), client-driven, manual wizard with copy-on-write + key-handling matrix, renewed-by/from links, one-renewal-per-cert | `certificate.renew` declared in catalog, unimplemented | BUILD(10) |
| 28 | Auto-renewal scheduler + per-cert/per-config renew-before-days | none | BUILD(10) actor |
| 29 | Certificate cleanup (delete N days post-expiry, skip-active-syncs, run reports) | none | BUILD(10) |
| 30 | Revocation with RFC 5280 reason codes → CRL | none | BUILD(5) + BUILD(7) route |
| 31 | Network TLS discovery: jobs (domains/IPs/CIDR≥/24, ports, limits 256/20/5), auto-scan interval, installations tracked by SHA-256 across scans, import-unmatched | none | BUILD(11) |
| 32 | Cloud-provider / filesystem discovery | **Infisical: "planned" only** | EXCLUDE — ADR 0066 roadmap parity |
| 33 | Alerting: expiration (window + daily reminders), issuance/renewal/revocation real-time; email, Slack, PagerDuty Events v2, webhook (CloudEvents 1.0 + HMAC) | none | BUILD(12) |
| 34 | Approval workflows: multi-step, M-of-N per step, users/groups, max-request-TTL, machine bypass, Open/Approved/Rejected/Cancelled/Expired | none | BUILD(9) |
| 35 | Code signing: Signers (statuses, one cert per signer, member roles, auto-renew) | none | BUILD(15) |
| 36 | Sign API (REST digest signing) | none | BUILD(15) |
| 37 | PKCS#11 v2.40 provider module (jarsigner/cosign/osslsigncode/apksigner/gpg) | none | BUILD(15) `crates/pkcs11-provider` cdylib |
| 38 | Windows KSP (CNG provider for signtool) | none | BUILD(15) as **build-only** crate: cross-compiled `x86_64-pc-windows-gnu` in the done-command, no runtime test on Linux — recorded validation limitation |
| 39 | Signing approvals: scoped pinning (command, app name, app SHA-256, hostname, OS user, IP, data hash), signature counters, signing windows, pre-approval, immutable access records | none | BUILD(15) |
| 40 | Certificate syncs (13 destinations, name-schema templating, re-sync on renew, remove-on-expiry) | refused by ADR 0052 ("no automatic deployment") | BUILD(17) — supersession ADR 0069: broker-fenced, admin-configured destinations, receipts; never agent-triggerable |
| 41 | Kubernetes cert-manager external issuer (CRDs, machine-identity auth, CA chain in `ca.crt`) | none | BUILD(18) `apps/k8s-issuer` (kube-rs, matching the repo's Rust toolchain) + ACME-server path for the stock cert-manager ACME issuer |
| 42 | Infisical Agent (daemon renewal loop, file outputs, post-hooks) | none | BUILD(19a) CLI: `opensesame cert agent` watch mode against the API-enrollment route |
| 43 | Terraform provider | none | EXCLUDE — ADR 0066: no Terraform surface exists in this repo; CLI/MCP/REST are the IaC surfaces per the ADR 0065 parity model |
| 44 | Access control: Product Admin/Member + application & signer roles + machine identities | owner/admin/member roles on sessions | BUILD(8) membership layer over existing `Caller` |
| 45 | Audit logs (immutable, PKI event metadata, per-signer activity) | signed `InvocationReceipt`s + identity-plane audit chain | BUILD per-swarm: every mutating certmgr route appends a host-plane outbox audit event (§4.6) + signing activity ledger BUILD(15) |
| 46 | Sub-organizations | org model exists | KEEP — OpenSesame orgs already scope every table |
| 47 | KMS/KMIP server, SSH CAs, PAM | separate Infisical products | EXCLUDE — out of Certificate Manager scope, noted in ADR 0066 |

---

## 3. Architecture decisions the swarm records as ADRs

The ADR & docs swarm (§5.1) writes these under `docs/adr/` (next free number is **0066**; two
files may not share a number going forward). Each names the exact files it changes and a
**Gate:** (test command) per decision, following `docs/adr/0065-connector-hook-architecture.md`'s
format. Code swarms cite them as `// ADR 006x:` comments where the invariants land.

- **ADR 0066 — Certificate Manager domain model.** Introduces CA hierarchy
  (root/intermediate, path length), certificate policies (3-state rules), profiles
  (CA+policy+defaults), applications (workspaces with admin/operator/auditor members),
  enrollment configs, and the inventory model (issued / imported / discovered sources; renewal
  linkage). Supersedes the "(dev TLS)" positioning in `docs/competitors/infisical.md`. Records
  the EXCLUDE dispositions of §2 (#8, #15, #26, #32, #43, #47) with rationale, as roadmap items
  rather than refusals where applicable.
- **ADR 0067 — Revocation: CRL and OCSP.** CRL generation/signing on revoke and on
  `next_update` horizon, CRL Distribution Point embedding in every internal-CA cert, up to 4
  advertised mirror URLs (advertise-only; the customer republishes), unauthenticated
  `GET /crl/{ca_id}.crl` and RFC 6960 OCSP responder at `/ocsp/{ca_id}` — the latter a
  deliberate differentiator (Infisical is CRL-only).
- **ADR 0068 — Enrollment protocol servers and the ACME directory supersession.**
  OpenSesame terminates ACME (RFC 8555, HTTP-01 + admin-enabled skip-validation, per-profile
  EAB), EST (RFC 7030), SCEP (RFC 8894, static/dynamic challenges). Client-side: upstream
  HTTP-01 stays refused (restating ADR 0052's rationale: DNS-01 is a strict superset, no
  inbound :80, wildcard support); the "arbitrary ACME directory" refusal is superseded
  **narrowly** — org admins may register private ACME directories (step-ca, Vault, internal
  Boulder) which are assigned trust class `private_local` in code; the `public_web` trust class
  remains pinned to the code-owned registry in `cert_issuers/registry.rs`.
- **ADR 0069 — Certificate syncs.** Supersedes ADR 0052's "no automatic certificate
  deployment" refusal. Constraints that made the supersession acceptable: destinations are
  admin-configured connections whose pushes run through `ConnectionBroker::authorized_json`
  egress fencing; key material is unsealed only inside the sync actor pass and never returned
  to any caller; every push emits a receipt/outbox audit event; sync configuration and
  execution are excluded from all agent surfaces.
- **ADR 0070 — Code signing.** Signers as authority handles (fulfilling the `SignerRef`
  named in ADR 0005), Sign API semantics (digest-only intake, never artifact upload), scoped
  approvals with immutable access records and signature counters, PKCS#11 provider module and
  build-only Windows KSP, per-signer activity ledger with redacted command lines.
- **ADR 0071 — HSM connectors.** PKCS#11 client (`cryptoki`) reached in-process by the
  gateway; slot label + sealed PIN + key-label prefix model; RSA-2048/4096 and ECDSA
  P-256/P-384 mechanisms; verify-on-create; SoftHSM2 as the CI validation target; HSM-backed
  keys implement the same signer trait as sealed keys so CA/signer code is custody-agnostic.
- **ADR 0072 — Kubernetes external issuer.** `apps/k8s-issuer` kube-rs controller with
  `Issuer`/`ClusterIssuer` CRDs (`certmgr.opensesame.dev` group) reconciling cert-manager
  `CertificateRequest`s against the API-enrollment route using machine-identity auth; the ACME
  server (ADR 0068) remains the zero-install path for the stock cert-manager ACME issuer.

The swarm also updates: `docs/security/threat-model.md` (new rows: enrollment-endpoint abuse,
CRL/OCSP spoofing, sync-destination exfiltration, signing-approval bypass, HSM PIN custody),
`docs/security/key-hierarchy.md` (CA/signer key custody section), a new
`docs/validation/certificate-manager.md` evidence doc, `docs/competitors/infisical.md`
(rewrite the certificate rows), `docs/standards-matrix.md` (RFC 5280, 8555, 7030, 8894, 6960,
6960-OCSP, 7468, 7292 rows), and bumps the ADR range in `AGENTS.md` (line ~220).

---

## 4. Shared contracts

These contracts are the coordination substrate. Swarms implement **against** them; the
Assembler (§5.20) wires them. Deviations require amending this section in the same PR.

### 4.1 Migration DDL — `migrations/0016_certificate_manager.sql`

Owned by the Persistence swarm (§5.2). One file, appended to `MIGRATIONS` in
`crates/storage/src/lib.rs`. Conventions are exactly those of `0013_certificate_issuance.sql`:
`TEXT` primary keys, RFC3339 `TEXT` timestamps, `organization_id TEXT NOT NULL REFERENCES
organizations(id)`, composite `UNIQUE(organization_id, id)`, `version INTEGER NOT NULL DEFAULT 1
CHECK (version > 0)` on mutable rows, partial unique indexes for one-default-per-org, and
all-or-nothing `CHECK` groups for sealed-blob column sets
(`sealed_key_id/sealed_ciphertext/sealed_nonce/sealed_aad_digest`, abbreviated below as
**SEALED(prefix)** = four columns `<prefix>_key_id, <prefix>_ciphertext, <prefix>_nonce,
<prefix>_aad_digest` plus the all-or-nothing CHECK).

Existing-table extensions (SQLite `ALTER TABLE ... ADD COLUMN`, all nullable or defaulted):

```sql
ALTER TABLE certificate_authorities ADD COLUMN kind TEXT NOT NULL DEFAULT 'root'
  CHECK (kind IN ('root','intermediate'));
ALTER TABLE certificate_authorities ADD COLUMN parent_id TEXT;              -- same-org CA id
ALTER TABLE certificate_authorities ADD COLUMN key_algorithm TEXT NOT NULL DEFAULT 'ecdsa-p256'
  CHECK (key_algorithm IN ('rsa-2048','rsa-4096','ecdsa-p256','ecdsa-p384','ed25519'));
ALTER TABLE certificate_authorities ADD COLUMN subject_json TEXT;           -- {cn,o,ou,c,st,l,dc:[..]}
ALTER TABLE certificate_authorities ADD COLUMN path_len INTEGER;            -- NULL = unlimited, 0 = no chaining
ALTER TABLE certificate_authorities ADD COLUMN key_source TEXT NOT NULL DEFAULT 'sealed'
  CHECK (key_source IN ('sealed','hsm'));
ALTER TABLE certificate_authorities ADD COLUMN hsm_connector_id TEXT;
ALTER TABLE certificate_authorities ADD COLUMN hsm_key_label TEXT;
ALTER TABLE certificate_authorities ADD COLUMN crl_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE certificate_authorities ADD COLUMN crl_mirrors_json TEXT;       -- up to 4 URLs, ordered
ALTER TABLE certificate_authorities ADD COLUMN pending_csr_pem TEXT;        -- externally-signed intermediate flow

ALTER TABLE issued_certificates ADD COLUMN application_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN profile_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN source TEXT NOT NULL DEFAULT 'issued'
  CHECK (source IN ('issued','imported','discovered'));
ALTER TABLE issued_certificates ADD COLUMN enrollment_method TEXT
  CHECK (enrollment_method IN ('api','acme','est','scep','ui','import'));
ALTER TABLE issued_certificates ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE issued_certificates ADD COLUMN key_algorithm TEXT;
ALTER TABLE issued_certificates ADD COLUMN signature_algorithm TEXT;
ALTER TABLE issued_certificates ADD COLUMN fingerprint_sha256 TEXT;         -- hex, lowercase
ALTER TABLE issued_certificates ADD COLUMN chain_pem TEXT;                  -- public material only
ALTER TABLE issued_certificates ADD COLUMN renewed_from_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN renewed_by_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN auto_renew_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issued_certificates ADD COLUMN renew_before_seconds INTEGER;
ALTER TABLE issued_certificates ADD COLUMN revocation_reason INTEGER;       -- RFC 5280 CRLReason code
ALTER TABLE issued_certificates ADD COLUMN revoked_at TEXT;
-- status gains values: existing rows keep theirs; new code writes one of
-- 'active','renewed','revoked','expired','pending' (validated in Rust, not by CHECK, to
-- avoid rewriting the applied 0013 constraint).
-- CORRECTION (was: "SEALED(sealed_key) columns for managed-key custody are added
-- here as well"). Do NOT add sealed private-key columns to issued_certificates.
-- ADR 0052 guarantees that table holds public material only: a private key
-- reaches its holder exactly once via the sealed, expiring, single-use delivery
-- on certificate_issuance_requests.delivery_ciphertext, which is nulled once
-- taken. crates/storage's pre-existing test
-- `atomic_certificate_delivery_is_encrypted_expiring_and_single_use` asserts
-- that no issued_certificates column matches private/ciphertext/nonce, and it
-- must keep passing unmodified. Managed-key custody instead lives in its own
-- `managed_certificate_keys` table (see the new-tables list below), so a
-- certificate list or projection query can never select key material and the
-- ADR 0052 invariant stays literally true and testable.
CREATE INDEX idx_issued_certificates_fingerprint
  ON issued_certificates(organization_id, fingerprint_sha256);
CREATE INDEX idx_issued_certificates_expiry
  ON issued_certificates(organization_id, status, expires_at);
```

New tables (full column lists; the Persistence swarm writes the literal SQL with the standard
FK/index/CHECK scaffolding described above):

| Table | Columns beyond (id, organization_id, version, created_at, updated_at) |
|---|---|
| `certificate_policies` | `name` (UNIQUE per org), `description`, `preset` CHECK IN ('tls_server','tls_client','code_signing','device','user','email_protection','dual_purpose_server','intermediate_ca','custom'), `max_validity_seconds`, `rules_json` (§4.4 PolicyRules document) |
| `certificate_profiles` | `name` (UNIQUE per org), `issuer_type` CHECK ('ca','self_signed'), `certificate_authority_id` NULL, `policy_id`, `defaults_json` (§4.4 ProfileDefaults), `external_template` NULL |
| `pki_applications` | `slug` (UNIQUE per org), `display_name`, `description` |
| `pki_application_members` | `application_id`, `subject` (principal/session subject or machine identity id), `role` CHECK ('admin','operator','auditor'); UNIQUE(org, application_id, subject) |
| `enrollment_configs` | `application_id`, `profile_id`, `method` CHECK ('api','acme','est','scep'), `enabled` INT, `config_json` (§4.4 per-method), `auto_renew_enabled` INT, `renew_before_seconds`, SEALED(sealed_secret) for the method secret (EST passphrase, SCEP static challenge, ACME EAB HMAC); UNIQUE(org, application_id, profile_id, method) |
| `managed_certificate_keys` | `certificate_id`, SEALED(sealed_key) under scope `managed_leaf_key`; UNIQUE(org, certificate_id); FK on the (org, id) pair of the certificate, ON DELETE CASCADE. **The only certificate-manager table permitted to hold private key material.** It exists solely to serve server-driven renewal and syncs (ADR 0069). No certificate read path — `list_certificates`, any detail view, any `*_view` projection — may join or select from it; only the renewal and sync paths read it, by explicit call. Keeping it separate is what preserves the ADR 0052 invariant on `issued_certificates` (see the CORRECTION note above) |
| `certificate_revocations` | `certificate_id`, `ca_id`, `serial`, `reason_code` INT (RFC 5280 CRLReason), `revoked_at`, `crl_number` INTEGER; UNIQUE(org, ca_id, serial) |
| `crl_state` | `ca_id`, `crl_number` INTEGER, `this_update`, `next_update`, SEALED(sealed_der) (the signed CRL DER), `mirror_urls_json`; UNIQUE(org, ca_id) |
| `discovery_jobs` | `name`, `description`, `targets_json` (domains/IPs/CIDRs), `ports_json`, `auto_scan` INT, `scan_interval_days`, `gateway_ref` NULL, `allow_internal` INT DEFAULT 0, `last_scan_at`, `status` CHECK ('idle','scanning','failed') |
| `discovery_installations` | `job_id`, `host`, `port` INT, `fingerprint_sha256`, `cn`, `issuer`, `not_after`, `first_seen_at`, `last_seen_at`, `change_log_json`, `matched_certificate_id` NULL; UNIQUE(org, job_id, host, port) |
| `approval_policies` | `scope` CHECK ('issuance','signing'), `application_id` NULL, `signer_id` NULL, `name`, `max_request_ttl_seconds`, `machine_bypass` INT, `covers_json` (profile ids for issuance) |
| `approval_steps` | `policy_id`, `seq` INT, `name`, `approvers_json` (user/group ids), `required_count` INT CHECK (>0), `notify` INT; UNIQUE(org, policy_id, seq) |
| `approval_requests` | `policy_id`, `kind` CHECK ('issuance','signing'), `requester`, `status` CHECK ('open','approved','rejected','cancelled','expired'), `current_step` INT, `expires_at`, `payload_digest`, `scope_json` (signing pin fields or issuance request), `result_id` NULL (issued cert or access record) |
| `approval_decisions` | `request_id`, `step_seq` INT, `approver`, `decision` CHECK ('approve','reject'), `comment`, `decided_at`; UNIQUE(org, request_id, step_seq, approver) |
| `signers` | `name` (UNIQUE per org), `certificate_id`, `key_source` CHECK ('sealed','hsm'), `hsm_connector_id` NULL, `hsm_key_label` NULL, `status` CHECK ('pending','active','failed','disabled','expired'), `auto_renew` INT, `renew_before_seconds`, SEALED(sealed_key) NULL (managed signer key) |
| `signer_members` | `signer_id`, `subject`, `role` CHECK ('administrator','operator','auditor'); UNIQUE(org, signer_id, subject) |
| `signing_access_records` | `signer_id`, `approval_request_id` NULL, `status` CHECK ('pending','active','expired','revoked','rejected'), `signatures_allowed` INT NULL (NULL = unlimited within window), `signatures_used` INT DEFAULT 0, `window_expires_at` NULL, `scope_json` (pinned command/app/checksum/hostname/os_user/ip/data_hash) |
| `signing_events` | `signer_id`, `access_record_id` NULL, `outcome` CHECK ('succeeded','failed','denied'), `command`, `application_name`, `application_sha256`, `hostname`, `os_username`, `ip`, `data_hash`, `occurred_at` (command line has credential args redacted before write) |
| `cert_alerts` | `application_id`, `type` CHECK ('expiration','issuance','renewal','revocation'), `before_window_seconds` NULL, `daily_reminder` INT, `channels_json` (≤10 channel configs) |
| `alert_deliveries` | `alert_id`, `channel`, `outcome` CHECK ('succeeded','failed','pending'), `attempts` INT, `last_attempt_at`, `payload_digest` |
| `cert_syncs` | `certificate_id`, `destination_kind`, `connection_id`, `name_schema`, `remove_on_expiry` INT, `include_root` INT, `options_json`, `enabled` INT, `last_run_at` |
| `sync_runs` | `sync_id`, `outcome` CHECK ('succeeded','failed'), `detail`, `ran_at` |
| `hsm_connectors` | `label` (UNIQUE per org), SEALED(sealed_pin), `module_hint`, `key_label_prefix` NULL, `gateway_ref` NULL, `status` CHECK ('unverified','verified','failed') |
| `external_ca_configs` | `kind` CHECK ('aws_pca','digicert_acme','digicert_direct','sectigo','godaddy','azure_adcs','venafi_cloud','private_acme'), `connection_id`, `config_json`, `trust_class` CHECK ('public_web','private_local','origin_only','test_only'), `auto_renew` INT, `renew_before_seconds` |
| `acme_server_accounts` | `profile_id`, `jwk_thumbprint` (UNIQUE per org+profile), `eab_kid`, `status` CHECK ('valid','deactivated'), `contacts_json` |
| `acme_orders` | `account_id`, `status` CHECK ('pending','ready','processing','valid','invalid'), `identifiers_json`, `expires_at`, `finalize_csr_pem` NULL, `certificate_id` NULL |
| `acme_challenges` | `order_id`, `authz_id`, `type` CHECK ('http-01','dns-01'), `token`, `status` CHECK ('pending','valid','invalid') |
| `acme_nonces` | `nonce` (UNIQUE per org), `issued_at` (single-use replay guard; consumed on POST) |
| `est_configs` | `profile_id`, SEALED(sealed_passphrase) NULL, `bootstrap_chain_pem` NULL, `require_bootstrap` INT |
| `scep_configs` | `profile_id`, `challenge_mode` CHECK ('static','dynamic'), SEALED(sealed_static_secret) NULL, `ra_signs_with_ca` INT, `include_ca_cert` INT, `allow_cert_renewal` INT |
| `scep_challenges` | `config_id`, `challenge_hash`, `expires_at`, `consumed_at` NULL; index on (org, config_id, expires_at) |

### 4.2 Route table (authoritative)

Namespace `/api/v1/certmgr/*` for management (session-auth, org-scoped, gated by §5.8 role
checks). Enrollment-protocol namespaces are profile-scoped with native protocol auth. Handler
modules live in `apps/gateway/src/routes/`. The Assembler (§5.20) mounts every row in
`routes/mod.rs` with the listed body limit and an `// ADR 006x:` comment, and lists each in
`api/openapi/openapi.yaml` or the `contract.rs` allowlist.

```
# Certificate Authorities — routes/certmgr_ca.rs (§5.6), 16 KiB
GET    /api/v1/certmgr/cas
POST   /api/v1/certmgr/cas                       create root|intermediate
GET    /api/v1/certmgr/cas/{id}
PATCH  /api/v1/certmgr/cas/{id}                   status | mirrors
GET    /api/v1/certmgr/cas/{id}/csr               export intermediate CSR
POST   /api/v1/certmgr/cas/{id}/import-chain      paste signed cert + chain (512 KiB)
POST   /api/v1/certmgr/cas/{id}/renew             same-key | new-key
GET|PATCH /api/v1/certmgr/cas/{id}/signing-config external-CA auto-renew config

# Policies — routes/certmgr_policy.rs (§5.4), 16 KiB
GET|POST          /api/v1/certmgr/policies
GET|PATCH|DELETE  /api/v1/certmgr/policies/{id}

# Profiles — routes/certmgr_profile.rs (§5.4), 16 KiB
GET|POST          /api/v1/certmgr/profiles
GET|PATCH|DELETE  /api/v1/certmgr/profiles/{id}

# Applications, members, enrollment configs — routes/certmgr_app.rs (§5.8), 16 KiB
GET|POST          /api/v1/certmgr/apps
GET|PATCH|DELETE  /api/v1/certmgr/apps/{id}
GET|POST          /api/v1/certmgr/apps/{id}/members
DELETE            /api/v1/certmgr/apps/{id}/members/{memberId}
GET|POST          /api/v1/certmgr/apps/{id}/enrollments
GET|PATCH|DELETE  /api/v1/certmgr/apps/{id}/enrollments/{enrollmentId}

# Issuance / inventory — routes/certmgr_inventory.rs (§5.7)
POST   /api/v1/certmgr/apps/{id}/certificates     API enrollment: CSR | managed-key (32 KiB)
GET    /api/v1/certmgr/certificates               filter: status,cn,san,profile,app,expiring-before,metadata.*
GET    /api/v1/certmgr/certificates/{id}
POST   /api/v1/certmgr/certificates/import        PEM | PKCS#12 (512 KiB)
POST   /api/v1/certmgr/certificates/{id}/export   pem | pkcs12 (human ceremony)
PATCH  /api/v1/certmgr/certificates/{id}/metadata
POST   /api/v1/certmgr/certificates/{id}/revoke   reason code
POST   /api/v1/certmgr/certificates/{id}/renew    manual wizard (copy-on-write + key handling)
DELETE /api/v1/certmgr/certificates/{id}
GET    /api/v1/certmgr/dashboard                  rollups for the dashboard UI

# Discovery — routes/certmgr_discovery.rs (§5.11), 16 KiB
GET|POST          /api/v1/certmgr/discovery/jobs
GET|PATCH|DELETE  /api/v1/certmgr/discovery/jobs/{id}
POST              /api/v1/certmgr/discovery/jobs/{id}/scan
GET               /api/v1/certmgr/discovery/installations
POST              /api/v1/certmgr/discovery/installations/{id}/import

# Alerts — routes/certmgr_alerts.rs (§5.12), 16 KiB
GET|POST          /api/v1/certmgr/apps/{id}/alerts
GET|PATCH|DELETE  /api/v1/certmgr/apps/{id}/alerts/{alertId}
GET               /api/v1/certmgr/apps/{id}/alerts/{alertId}/deliveries

# Approvals — routes/certmgr_approvals.rs (§5.9), 16 KiB
GET|POST          /api/v1/certmgr/apps/{id}/approval-policies
GET|PATCH|DELETE  /api/v1/certmgr/apps/{id}/approval-policies/{policyId}
GET               /api/v1/certmgr/approval-requests            filter status|app
POST              /api/v1/certmgr/approval-requests/{id}/decision    approve|reject + comment
POST              /api/v1/certmgr/approval-requests/{id}/cancel

# Signers & signing — routes/certmgr_signers.rs (§5.15)
GET|POST          /api/v1/certmgr/signers                        16 KiB
GET|PATCH|DELETE  /api/v1/certmgr/signers/{id}
GET|POST          /api/v1/certmgr/signers/{id}/members
POST              /api/v1/certmgr/signers/{id}/sign              Sign API: digest in, signature out (64 KiB)
GET|POST          /api/v1/certmgr/signers/{id}/approval-policies
GET               /api/v1/certmgr/signers/{id}/activity
GET|POST          /api/v1/certmgr/signing-requests
POST              /api/v1/certmgr/signing-requests/{id}/decision
GET               /api/v1/certmgr/signing-access-records
POST              /api/v1/certmgr/signing-access-records/{id}/revoke

# Syncs — routes/certmgr_syncs.rs (§5.17), 16 KiB
GET|POST          /api/v1/certmgr/certificates/{id}/syncs
GET|PATCH|DELETE  /api/v1/certmgr/syncs/{id}
POST              /api/v1/certmgr/syncs/{id}/run

# HSM & external-CA connectors — routes/certmgr_connectors.rs (§5.16), 16 KiB
GET|POST          /api/v1/certmgr/hsm-connectors
GET|PATCH|DELETE  /api/v1/certmgr/hsm-connectors/{id}
GET|POST          /api/v1/certmgr/external-cas
GET|PATCH|DELETE  /api/v1/certmgr/external-cas/{id}

# Enrollment-protocol endpoints (profile-scoped, native auth, no session)
# ACME server — routes/acme_server.rs (§5.13)
GET  /acme/{profileId}/directory
HEAD /acme/{profileId}/new-nonce
POST /acme/{profileId}/new-account            EAB required
POST /acme/{profileId}/new-order
POST /acme/{profileId}/authz/{authzId}
POST /acme/{profileId}/challenge/{challengeId}
POST /acme/{profileId}/finalize/{orderId}
POST /acme/{profileId}/cert/{certId}
POST /acme/{profileId}/revoke-cert
# EST — routes/est_server.rs (§5.14), under .well-known
GET  /.well-known/est/{profileId}/cacerts
POST /.well-known/est/{profileId}/simpleenroll     mTLS | passphrase
POST /.well-known/est/{profileId}/simplereenroll
# SCEP — routes/scep_server.rs (§5.14)
GET  /scep/{profileId}/pkiclient.exe?operation=GetCACaps
GET  /scep/{profileId}/pkiclient.exe?operation=GetCACert
POST /scep/{profileId}/pkiclient.exe?operation=PKIOperation
POST /scep/{profileId}/challenge                    dynamic one-time challenge mint (authenticated)
# Revocation distribution — routes/revocation.rs (§5.5)
GET  /crl/{caId}.crl                                 DER
GET  /crl/{caId}.pem
POST /ocsp/{caId}                                    RFC 6960 request (application/ocsp-request)
GET  /ocsp/{caId}/{base64request}
```

### 4.3 Storage accessor surface (authoritative signatures)

Added to `impl Db` in `crates/storage/src/lib.rs` by §5.2. Every method is `pub async fn`,
returns `anyhow::Result<...>` (point reads `Result<Option<...>>`), carries `/// # Errors`, and is
org-scoped (first arg an `&OrganizationId`, or an id already proven to belong to the org). Route
swarms code against these names; §5.2 implements them and adds the symmetric CRUD siblings and the
row structs (with redacting `Debug` on any sealed carrier). Representative set:

```
insert/get/list/update/delete_certificate_policy
insert/get/list/update/delete_certificate_profile
insert_ca_link · get_ca_children · get_ca_parent · get_signing_config · update_signing_config
set_ca_pending_csr · complete_ca_import
insert/get/list/update/delete_pki_application
upsert_application_member · list_application_members · remove_application_member · effective_app_role
insert/get/list/update/delete_enrollment_config · get_enrollment_by_profile_method
insert_managed_certificate · get_certificate · list_certificates(filter) · delete_certificate
set_certificate_metadata · get_certificate_metadata
insert_certificate_revocation · list_revocations_for_ca
get_crl_state · upsert_crl_state
insert_renewal_link · get_renewed_by · get_renewed_from
insert/get/list/update/delete_discovery_job
record_installation · list_installations · match_installation_by_fingerprint
insert/get/list/update/delete_approval_policy · list_steps_for_policy
insert_approval_request · get/list/transition_approval_request
insert_approval_decision · list_decisions_for_request
insert/get/list/update/delete_signer · upsert_signer_member · list_signer_members · effective_signer_role
insert_signing_access_record · list_active_records · increment_signature_count · revoke_access_record
append_signing_event · list_signing_events
insert/get/list/update/delete_cert_alert · record_alert_delivery · list_alert_deliveries
insert/get/list/update/delete_cert_sync · record_sync_run · list_active_syncs_for_certificate
insert/get/list/update/delete_hsm_connector
insert/get/list/update/delete_external_ca_config
insert_acme_account · get_acme_account · insert_acme_order · get/transition_acme_order
insert_acme_challenge · get_acme_challenge · mint_acme_nonce · consume_acme_nonce
insert_est_config · get_est_config
insert_scep_config · get_scep_config · mint_scep_challenge · consume_scep_challenge
list_certificates_expiring_before(org, cutoff)          -- reuse the existing helper's shape
dashboard_rollup(org)                                   -- counts by status/algorithm/CA + expiry buckets
```

### 4.4 JSON document shapes (the `*_json` columns)

Fully specified so no swarm invents a shape at runtime. All are serde structs in a shared module
`crates/pki-core::types` re-exported to the gateway.

- **PolicyRules** (`certificate_policies.rules_json`): `{ subject: { cn|o|ou|c|st|l: FieldRule,
  dc: DcRule }, san: { dns|ip|email|uri|upn: SanRule }, signature_algorithms: Constraint<SigAlg>,
  key_algorithms: Constraint<KeyAlg>, key_usages: Constraint<KeyUsage>, ext_key_usages:
  Constraint<Eku>, basic_constraints: { ca: 'forbid'|'allow'|'require', max_path_len: u8? } }`.
  `FieldRule = { mode: 'unset'|'require'|'allow'|'deny', values: [String] (fixed or `*`-wildcard) }`;
  the 3-state semantics (§1: unset=allow-any, `mode:'allow'` with `values:[]` = deny-all,
  populated = whitelist) live in the evaluator (§5.4). `Constraint<T> = { mode:
  'unset'|'allow'|'require', allowed: [T], required: [T] }`.
- **ProfileDefaults** (`certificate_profiles.defaults_json`): `{ ttl_seconds, subject: {..},
  key_algorithm, signature_algorithm, key_usages: [..], ext_key_usages: [..], basic_constraints:
  {..} }` — validated against the profile's policy at write time.
- **enrollment_configs.config_json** per method: `api` → `{ mode: 'csr'|'managed', metadata_keys:
  [..] }`; `acme` → `{ challenge: 'http-01'|'skip', eab_required: true }`; `est` → `{ port: 8443,
  require_bootstrap }`; `scep` → `{ challenge_mode, ra_signs_with_ca, include_ca_cert }`.
- **discovery_jobs.targets_json**: `{ domains: [..], ips: [..], cidrs: [..] }` (limits enforced in
  §5.11: ≤20 domains, ≤256 IPs total, CIDR ≥ /24); **ports_json**: `[Int]` (≤5).
- **cert_alerts.channels_json**: `[ { kind: 'email'|'slack'|'pagerduty'|'webhook', ...cfg } ]` —
  email `{ addresses: [..] }`; slack `{ connection_id }` (webhook URL held by the connection);
  pagerduty `{ connection_id }`; webhook `{ url, hmac_secret_ref? }` (URL must be https).
- **signing_access_records.scope_json** / **approval_requests.scope_json** (signing): `{ command?,
  application_name?, application_sha256?, hostname?, os_username?, ip?, data_hash? }` — any subset;
  a sign is permitted only if every present field matches (§5.15).
- **CloudEvents webhook payload** (§5.12): CloudEvents 1.0 JSON, `type:
  "com.opensesame.certmgr.<event>"`, `source: "/certmgr/apps/<id>"`, `data: { certificate: {..non-secret..} }`;
  optional header `x-opensesame-signature: t=<unix_seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`.

### 4.5 Seal-scope constants

Exposed from `crates/storage` (or `crates/connection-broker::crypto`), imported by route swarms.
One scope per secret purpose, mirroring the existing `CA_SCOPE`/`DELIVERY_SCOPE`:

```
certificate_authority (existing)   certificate_delivery (existing)
managed_leaf_key   enrollment_secret   eab_secret   est_passphrase
scep_static_secret   signer_key   hsm_pin   external_ca_credential
crl_der   acme_account_key
```

### 4.6 Capability IDs and the audit contract

**Audit:** every mutating certmgr route appends a host-plane outbox event in the same transaction
as its state change via `append_outbox_tx` (model `apps/gateway/src/github_webhook.rs:90`), event
type `certmgr.<object>.<verb>` (`certmgr.ca.created`, `certmgr.certificate.revoked`,
`certmgr.signer.signed`, …), payload a non-secret projection. `signing_events` is the code-signing
activity ledger (§5.15).

**Capabilities:** dot-namespaced under `certmgr.`, added to
`packages/capability-registry/src/index.ts` by the Assembler from each swarm's staged rows.
Agent-surface rule: `read` capabilities map to `mcp_host`/`webmcp` read tools with Zod
projections; any `act`/`admin`/`ceremony` capability that touches key material or signing is
webmcp-excluded (reason + `ADR_AGENT_SURFACE_PARITY`) exactly like today's `certs.issue`; syncs
and connectors are excluded from every agent surface (§5.17/ADR 0069). Representative ids:
`certmgr.ca.list|create|renew|revoke`, `certmgr.policy.*`, `certmgr.profile.*`, `certmgr.app.*`,
`certmgr.cert.list|issue|import|export|revoke|renew|metadata`,
`certmgr.discovery.jobs|scan|installations`, `certmgr.alert.*`, `certmgr.approval.list|decide`,
`certmgr.signer.list|create|sign`, `certmgr.sync.*`, `certmgr.connector.hsm|externalca`,
`certmgr.dashboard.read`.

---

## 5. Subagent swarm specifications

Each swarm is dispatched independently and codes only against §1–§4 and the repository. "Reuse"
pointers are existing symbols to build on. Every swarm writes tests in the repo idiom (inline
`#[cfg(test)] mod tests` or a sibling `tests.rs` for Rust; co-located `*.test.ts(x)` for TS) and
finishes with its done-command green.

### 5.1 ADR & documentation swarm
- **Owns:** `docs/adr/0066-*.md`…`0072-*.md`; `docs/validation/certificate-manager.md`; new rows in
  `docs/security/threat-model.md` and `docs/security/key-hierarchy.md`;
  `docs/standards-matrix.md` RFC rows; rewrite of the certificate rows in
  `docs/competitors/infisical.md`.
- **Detail:** write the seven ADRs per §3 in house format (each names the files its decision lands
  in + a `Gate:` command). The validation doc mirrors
  `docs/validation/automatic-certificate-issuance.md`: delivered behavior, schema, standards,
  coverage/mutation/fuzz numbers, and an explicit residual-risk/limitations list matching §6's
  table (Windows KSP build-only, external-CA fixture-mocked, Intune/ADCS-WCCE excluded, ML-DSA
  roadmap, no live-cluster K8s e2e).
- **Reuse:** ADR 0052 and `docs/validation/automatic-certificate-issuance.md` as templates.
- **Done:** files exist; `packages/capability-registry/src/registry.test.ts` (which asserts each
  cited ADR filename exists) passes once capability rows cite these ADRs.

### 5.2 Persistence swarm
- **Owns:** `migrations/0016_certificate_manager.sql`; the `MIGRATIONS` entry in
  `crates/storage/src/lib.rs`; all new row structs, seal-scope constants (§4.5), and `impl Db`
  accessors (§4.3).
- **Detail:** write the full DDL per §4.1; redacting `Debug` for every sealed carrier (model
  `SealedCertificateMaterial`); org-scoped accessors with `/// # Errors`; inline tests for
  insert/read-back, cross-org isolation (a second org cannot read the first's rows), optimistic
  `version` conflict, and sealed-blob CHECK groups (partial insert rejected). Do not rewrite the
  applied `0013` status CHECK — new status values are validated in Rust (§4.1 note).
- **Reuse:** `seal_scoped`/`open_scoped` (`routes/certs.rs:154`), existing certificate row structs,
  `list_issued_certificates_expiring_before`.
- **Done:** `cargo +1.88.0 test -p opensesame-storage`; migration applies from empty in the storage
  harness.

### 5.3 PKI engine swarm
- **Owns:** `crates/pki-core` (new): CA generation (root + intermediate, path-len, DN builder, key
  algs RSA-2048/4096, ECDSA P-256/P-384, Ed25519 leaves), CSR parse+validate+sign, KU/EKU/basic-
  constraints + CDP + AIA extension builders, chain assembly + verification (generalize
  `normalize_external_certificate`), PKCS#12 build (password-encrypted) + parse (multi-entry
  enumeration), PEM bundle assembly, SHA-256 fingerprint util, the `types` module holding every
  §4.4 serde struct, and a custody-agnostic `Signer` trait (impl'd by sealed keys now, HSM keys by
  §5.16).
- **Detail:** a provider-agnostic library — no axum, no storage. Fuzz targets for CSR + PKCS#12
  parsing under `fuzz/fuzz_targets/` (register in `fuzz/Cargo.toml`, model
  `certificate_request.rs`). Property tests: keygen→CSR→sign→parse round-trip per algorithm;
  PKCS#12 build→parse identity; every signed leaf chains to its issuer.
- **Reuse:** `cert_issuers/model.rs` (`GeneratedLeafRequest`, `leaf_params`,
  `normalize_external_certificate`); `rcgen`, `x509-parser` already vetted.
- **Done:** `cargo +1.88.0 test -p opensesame-pki-core`; `cargo +1.88.0 build -p opensesame-pki-core`;
  new fuzz targets build.

### 5.4 Policy & profile swarm
- **Owns:** the `policy` evaluator module in `crates/pki-core`; routes
  `apps/gateway/src/routes/certmgr_policy.rs` and `certmgr_profile.rs`.
- **Detail:** 3-state field enforcement (§4.4 PolicyRules) across subject attrs, SAN types,
  signature/key algorithms, KU/EKU, basic constraints; the 8 presets as constructor functions;
  profile = CA + policy + defaults + issuer type; profile defaults validated against policy at
  write time, requests validated at issue time. Routes: CRUD with `deny_unknown_fields`, admin
  gate, `*_view` projections. Property tests over the 3-state matrix; a request violating each rule
  class is rejected with a specific error.
- **Reuse:** global constants in `model.rs` (`MAX_TTL`, `MAX_DNS_NAMES`) become per-policy fields.
- **Done:** `cargo +1.88.0 test` for the owned modules; policy property tests green.

### 5.5 Revocation swarm (CRL + OCSP)
- **Owns:** the `revocation` module in `crates/pki-core`; `apps/gateway/src/routes/revocation.rs`
  (`/crl/*`, `/ocsp/*`); the CRL regeneration function invoked by the revoke path (§5.7) and the
  lifecycle actor (§5.10) — coordinated only through the `crl_state` table.
- **Detail:** RFC 5280 CRL v2 with reason codes, monotonic CRL number, CDP embedding input consumed
  by §5.3/§5.6, up to 4 advertised mirror URLs (advertise-only). RFC 6960 OCSP responder: parse
  request, look up revocation, return signed good/revoked/unknown; optional delegated OCSP-signing
  cert. CRL DER sealed (`crl_der` scope). Adversarial tests: revoked serial appears in CRL and OCSP
  says revoked; unrelated serial says good; tampered CRL fails verification; OCSP response signed
  only by the CA or its delegate.
- **Reuse:** `x509-cert`/`cms` builders; CA sealed-key open path (§5.2/§5.6).
- **Done:** `cargo +1.88.0 test` for owned modules; a CRL round-trips through a pure-Rust re-parse
  (preferred over shelling to `openssl` for hermeticity).

### 5.6 CA management routes swarm
- **Owns:** `apps/gateway/src/routes/certmgr_ca.rs`.
- **Detail:** create root or intermediate (intermediate references a parent CA id; path-len
  enforced via `certificate_authority_links`); export intermediate CSR; import a signed
  intermediate + chain (validate it chains to the named parent or an uploaded external root);
  store/patch external signing-config; renew same-key or new-key (new-key mints a fresh keypair,
  re-signs, links old→new, old-issued certs stay valid); status transitions. CA keys sealed
  (`certificate_authority` scope); HSM-backed CAs delegate signing to the §5.3 `Signer` trait
  backed by §5.16 (key never leaves the HSM). Admin gate + ordering pact (authorize → load parent →
  seal/persist). `*_view` never emits key material.
- **Reuse:** `crates/pki-core` CA builders; `dev_pki.rs::validate_ca`; `routes/certs.rs` sealing;
  §4.3 accessors.
- **Done:** route contract test; inline tests — root+intermediate chains; member cannot create a CA;
  cross-org CA invisible; new-key renewal preserves old-cert validity.

### 5.7 Inventory routes swarm
- **Owns:** `apps/gateway/src/routes/certmgr_inventory.rs`
  (list/detail/import/export/metadata/revoke/renew-dispatch/delete/dashboard).
- **Detail:** list with the §4.2 filters; detail view assembling subject/extensions/crypto/
  metadata/renewal-links (no key material); import PEM or PKCS#12 (enumerate multi-entry keystores,
  caller selects entries, store `source=imported`, seal any managed key); export PEM files or
  password-encrypted PKCS#12 as a human-ceremony response (audited); metadata CRUD (preserved
  across renewals by §5.10); revoke (reason → §5.5 CRL/OCSP state + status transition); dashboard
  rollup feeding the UI. Renew delegates to §5.10's manual-renewal logic.
- **Reuse:** `crates/pki-core` PKCS#12/PEM; `normalize_external_certificate` for import validation;
  the existing `GET /api/v1/certs` list projection as a shape guide.
- **Done:** contract test; inline tests — import a PKCS#12 fixture and read it back; export
  round-trips; revoke flips status and lands in CRL state; metadata survives a simulated renewal;
  cross-org isolation.

### 5.8 Applications & access swarm
- **Owns:** `apps/gateway/src/routes/certmgr_app.rs`; the role helper
  `apps/gateway/src/routes/certmgr_roles.rs` layering application/signer roles over `Caller`.
- **Detail:** application CRUD; membership (user / machine-identity / group refs) with roles
  admin/operator/auditor; enrollment-config CRUD per application+profile. The helper resolves a
  `Caller` to an effective role and exposes `require_app_role(st, headers, app_id, min_role)` (used
  by §5.7/§5.9/§5.12/§5.17) and `require_signer_role(...)` (used by §5.15). Org owner/admin is always
  product-admin.
- **Reuse:** `resolve_caller`, `Caller::in_organization`, `can_configure_integrations`
  (`middleware/auth.rs`).
- **Done:** contract test; tests — operator can issue but not edit members; auditor read-only; a
  non-member of another org's app gets 404 (existence hidden).

### 5.9 Approvals swarm
- **Owns:** `apps/gateway/src/routes/certmgr_approvals.rs`; the approval-evaluation module used by
  issuance (§5.7/§5.8) and signing (§5.15).
- **Detail:** multi-step sequential policies; per-step approvers + required M-of-N distinct
  approvers + notify; policy scoped to profiles (issuance) or a signer (signing); max-request-TTL
  expiry; machine-identity bypass. Lifecycle open→approved/rejected/cancelled/expired; a decision
  advances the step; final step auto-issues (issuance) or activates an access record (signing).
  Self-approval forbidden by default. Stale-request expiry handled by the lifecycle actor (§5.10).
  Notifications via §5.12 channels.
- **Reuse:** outbox fan-out; §5.8 role helper.
- **Done:** contract test; tests — 2-of-3 needs 3 distinct approvers for 2 approvals; requester
  cannot self-approve; TTL expiry transitions to expired; machine bypass only when enabled.

### 5.10 Renewal & lifecycle actor swarm
- **Owns:** `apps/gateway/src/cert_lifecycle.rs` (new actor); the manual-renewal logic module
  invoked by §5.7; makes the catalog `certificate.renew` op real.
- **Detail:** an interval actor modeled exactly on `apps/gateway/src/rotation_scheduler.rs`
  (`tokio::time::interval`, `MissedTickBehavior::Skip`, `pub async fn pass(&state) -> Result<usize>`,
  per-item failure isolation, "last attempted" advanced every pass). Each pass: (a) auto-renew
  managed-key certs at `expires_at − renew_before`; re-issue via profile, link predecessor→successor,
  carry metadata/syncs/auto-renew, re-run syncs (§5.17), fire renewal alerts (§5.12); (b) regenerate
  CRLs near `next_update` (§5.5); (c) expire stale approval requests (§5.9); (d) certificate cleanup
  — delete certs N days past expiry, skipping those with active syncs, recording a run report.
  Manual renewal: copy-on-write (untouched fields carry, profile defaults NOT re-applied, policy
  re-validated), key-handling matrix by issuer (private CA: reuse+CSR; external: CSR only;
  self-signed: reuse only), one-renewal-per-cert guard, new serial, bidirectional link. Config in
  `config.rs` + `.env.schema` (`OPENSESAME_CERT_LIFECYCLE_TICK_SECONDS`, cleanup retention default).
- **Reuse:** `rotation_scheduler.rs` structure verbatim; §5.3 issuance; §5.5 CRL; §5.12 alerts;
  §5.17 syncs — all through storage/state seams.
- **Done:** `cargo +1.88.0 test` for the actor's inline `#[tokio::test]`s (a due cert is renewed and
  linked; a cert with an active sync is not cleaned up; a pass with one failing item still processes
  the rest and advances). The Assembler spawns it in `main.rs`.

### 5.11 Discovery swarm
- **Owns:** `apps/gateway/src/routes/certmgr_discovery.rs`; `apps/gateway/src/cert_discovery.rs`
  (scanner + scan actor).
- **Detail:** jobs with targets (domains, IPs, CIDR ≥ /24), ports (default common TLS set), limits
  (≤256 IPs, ≤20 domains, ≤5 ports); auto-scan interval + manual scan. The scanner opens TLS to
  each target:port, captures the presented leaf, records an installation keyed by host:port with
  SHA-256 fingerprint and a change log across scans; matches to inventory by fingerprint; unmatched
  installations importable into inventory (via §5.7). One of the two sanctioned raw-egress paths
  (§1.3 rule 6): constrain connections to the job's declared targets only, honor the
  gateway/allow-internal flag, cap concurrency + timeout. Deterministic tests spin an in-process
  `tokio` TLS listener presenting a fixture cert and assert discovery + fingerprint match + change-
  log growth across two scans.
- **Reuse:** `hyper-rustls`; the actor shape from `rotation_scheduler.rs`; fixture certs from
  `crates/pki-core`.
- **Done:** contract test; scanner tests green against the in-process listener; limit-enforcement
  tests (a job over any cap rejected).

### 5.12 Alerting swarm
- **Owns:** `apps/gateway/src/routes/certmgr_alerts.rs`; `apps/gateway/src/cert_alerts.rs` (channel
  senders + delivery ledger).
- **Detail:** alert configs per application: expiration (before-window + optional daily reminder,
  checked daily by §5.10); issuance/renewal/revocation (real-time, fired by the owning route).
  Channels (≤10): email; Slack incoming webhook; PagerDuty Events v2 (severity ≤7d critical / ≤14d
  error / ≤30d warning / else info; revocation = warning; dedup key); webhook (HTTPS-only POST,
  CloudEvents 1.0, HMAC-SHA256 `t=,v1=` header — exact shapes in §4.4). All outbound through
  `ConnectionBroker::authorized_json`. Deliveries in `alert_deliveries`, retried via the outbox
  compensation ladder.
- **Reuse:** outbox append + compensation (`backup.rs`); broker egress (`BrokeredDns01`).
- **Done:** contract test; sender unit tests assert exact wire bytes (CloudEvents JSON, HMAC value
  for a known key+payload, PagerDuty severity table); a failed delivery retries and is ledgered.

### 5.13 ACME server swarm
- **Owns:** `apps/gateway/src/routes/acme_server.rs`; an `acme_server` module (JWS verification +
  order state) in the gateway or `crates/pki-core`.
- **Detail:** RFC 8555 server — directory, new-nonce, new-account (EAB required, per-profile EAB
  from the enrollment config), new-order, authz, challenge (HTTP-01 or admin-enabled skip-validation),
  finalize (accept CSR, validate against the profile policy, issue via §5.3/the profile CA), cert
  download, revoke-cert (→ §5.5). Nonce single-use replay guard (`acme_nonces`); JWS signature
  verification; account key thumbprint storage. HTTP-01 validation fetches
  `http://<identifier>/.well-known/acme-challenge/<token>` — the second sanctioned raw-egress path
  (§1.3 rule 6), constrained to the order identifiers. Hermetic e2e drives the server with the
  in-tree `instant-acme` client from `[dev-dependencies]`.
- **Reuse:** `instant-acme` types; `crates/pki-core` issuance + policy validation; `acme_*`
  accessors.
- **Done:** contract test; hermetic e2e — client obtains a cert against a skip-validation profile;
  EAB required; replayed nonce rejected; a policy-violating CSR rejected at finalize.

### 5.14 EST & SCEP swarm
- **Owns:** `apps/gateway/src/routes/est_server.rs`, `scep_server.rs`; `crates/scep` (CMS/PKCS#7
  codec).
- **Detail (EST, RFC 7030):** `/cacerts` (PKCS#7 chain), `/simpleenroll` + `/simplereenroll`
  (PKCS#10 in, PKCS#7 out), auth by EST passphrase or bootstrap-cert validated against an uploaded
  CA chain (optionally disabled), mTLS re-enrollment. **Detail (SCEP, RFC 8894):** GetCACaps,
  GetCACert (RA + chain as PKCS#7), PKIOperation (PKCSReq/RenewalReq/GetCertInitial) with CMS-wrapped
  requests; static challenge (shared ≥8-char, hashed) and dynamic one-time challenges (minted at an
  authenticated `/challenge`, expiry ≤1440 min, ≤1000 pending); options RA-cert-signed-by-CA
  (internal CAs only, immutable once set), include-CA-cert, allow-cert-renewal. CMS algs
  AES-256/128-CBC + SHA-256/384/512.
- **Reuse:** `crates/pki-core` issuance + `crates/scep` codec; `est_*`/`scep_*` accessors.
- **Done:** contract tests; interop tests with recorded fixture requests — valid SCEP PKCSReq with a
  correct static challenge issues; wrong challenge rejected; dynamic challenge single-use; EST
  simpleenroll with a valid bootstrap cert issues, invalid rejected.

### 5.15 Code-signing swarm
- **Owns:** `apps/gateway/src/routes/certmgr_signers.rs`; `crates/pkcs11-provider` (cdylib);
  `crates/windows-ksp` (build-only); the signing-approval scope evaluation (signing variant of
  §5.9's engine).
- **Detail:** signers (one cert each, key_source sealed|hsm, statuses, auto-renew); Sign API
  (`POST .../signers/{id}/sign`: digest + context in, signature out — raw key never leaves the
  gateway/HSM); member roles via §5.8. Signing approvals: multi-step M-of-N; request-level scope
  pinning (command whitespace-tolerant, app executable name, app SHA-256, hostname, OS username,
  server-observed IP, data hash — §4.4 scope_json); per-approval signature cap + signing window
  (1h/8h/24h/7d/30d/none); operator "request to sign" (justification) and administrator
  "pre-approve"; self-approval forbidden; approved requests become immutable active access records
  with live counters + revoke; every attempt (allowed or denied) appended to `signing_events` with
  credential args redacted. `crates/pkcs11-provider`: a `cdylib` exposing PKCS#11 v2.40 sign-only
  functions (C_Initialize/C_OpenSession/C_Login/C_FindObjects/C_SignInit/C_Sign…) proxying to the
  Sign API over the daemon socket; token label = signer name; machine-identity auth.
  `crates/windows-ksp`: a CNG KSP stub compiled build-only for `x86_64-pc-windows-gnu`.
- **Reuse:** Ed25519 signing in `crates/proof`; §5.9 approval engine; §5.16 `hsm-client` for
  HSM-backed signers; the `SignerRef` concept from ADR 0005.
- **Done:** contract tests; Rust tests — a scoped request permits a matching sign and denies a
  mismatched data hash; the counter decrements and the record expires at the window;
  `cargo +1.88.0 build -p opensesame-pkcs11-provider` produces the cdylib;
  `cargo +1.88.0 build --target x86_64-pc-windows-gnu -p opensesame-windows-ksp` succeeds
  (build-only, recorded limitation). If the Windows target toolchain is absent in CI, the
  done-command degrades to a `#[cfg(target_os = "windows")]` compile guard + a validation-doc note;
  the swarm states which applied.

### 5.16 External CA & HSM swarm
- **Owns:** `apps/gateway/src/routes/certmgr_connectors.rs`; adapters under
  `apps/gateway/src/cert_issuers/external/` (aws_pca, digicert, sectigo, godaddy, azure_adcs,
  venafi_cloud, private_acme); catalog rows in `crates/connection-broker/src/catalog.json`;
  `crates/hsm-client` (`cryptoki` PKCS#11 client).
- **Detail:** each external-CA adapter issues/revokes through `ConnectionBroker::authorized_json`
  with the provider's egress allowlist, mapping OpenSesame's request onto the provider API and
  normalizing the returned chain via `normalize_external_certificate`; async providers (Venafi,
  Azure ADCS) model 202 + poll. `private_acme` registers an admin-supplied ACME directory with trust
  class `private_local`, pinned TLS, optional EAB (ADR 0068); `public_web` stays code-pinned in
  `cert_issuers/model.rs`. `crates/hsm-client`: open a PKCS#11 session against a configured module
  (SoftHSM2 in CI), implement the §5.3 `Signer` trait for HSM-held keys; PIN sealed (`hsm_pin`).
  Connector CRUD stores sealed credentials and never echoes them.
- **Detail (validation):** every HTTP adapter has a recorded-fixture contract test (request shape +
  canned success/failure) — no live third-party calls in CI. `hsm-client` has a SoftHSM2 integration
  test gated behind a cargo feature / env probe; absent SoftHSM2, it skips with a recorded limitation
  and a mock-token unit test exercises the path.
- **Reuse:** `cert_issuers/registry.rs` (`ExternalIssuerDescriptor`, `EXTERNAL_ISSUERS`,
  `BrokeredDns01`); catalog category `certificates`.
- **Done:** a `registry_rows_agree_with_the_catalog`-style test passes for the new rows; adapter
  fixture tests green; `cargo +1.88.0 build -p opensesame-hsm-client`.

### 5.17 Sync swarm
- **Owns:** `apps/gateway/src/routes/certmgr_syncs.rs`; framework + destination adapters under
  `apps/gateway/src/cert_syncs/`.
- **Detail (ADR 0069):** sync configs bind a cert to a destination via a connection; name-schema
  templating (`{{certificateId}}` 32-char, `{{shortCertificateId}}` 22-char, `{{commonName}}`,
  `{{profileId}}`, `{{applicationId}}`, `{{applicationName}}`, per-destination sanitization);
  remove-on-expiry; include-root; auto re-sync when §5.10 renews the cert; only OpenSesame-managed
  certs. Destinations: AWS ACM / ELB / Secrets Manager, Azure Key Vault, GCP Certificate Manager,
  Cloudflare, Chef, Citrix NetScaler, Kemp LoadMaster, F5 BIG-IP, Nutanix Prism (HTTP →
  broker-fenced, fixture contract tests); Linux (SSH) and Windows (WinRM) via daemon-side executors
  behind cargo features (default off, like the pm-bridge binaries, ADR 0053). Runs in `sync_runs`;
  retries via outbox compensation. Never agent-triggerable (no MCP act mapping; `certmgr.sync.*`
  excluded from every agent surface).
- **Reuse:** broker egress; outbox compensation; feature-gating from `apps/pm-bridges`.
- **Done:** contract test; adapter fixture tests assert the exact push payload per destination;
  name-schema unit tests; a renewal triggers a re-sync in a test double.

### 5.18 Kubernetes issuer swarm
- **Owns:** `apps/k8s-issuer` (new binary `opensesame-k8s-issuer`): a kube-rs controller with CRDs
  `Issuer`/`ClusterIssuer` (group `certmgr.opensesame.dev`) reconciling cert-manager
  `CertificateRequest`s by calling the API-enrollment route (§5.7) with a machine-identity token,
  populating `status.certificate` + `ca.crt`; manifests under `apps/k8s-issuer/deploy/` + README.
- **Detail:** machine-identity auth (universal or in-cluster token); SPIFFE/URI-SAN passthrough.
  Document using the stock cert-manager ACME `ClusterIssuer` against §5.13's ACME server as the
  zero-code path. Reconcile tested against a `kube` fake client (no live cluster). Recorded
  limitation: no live-cluster e2e.
- **Reuse:** the API-enrollment route as backend; `kube`/`k8s-openapi` pins (§4.1).
- **Done:** `cargo +1.88.0 test -p opensesame-k8s-issuer`; `cargo +1.88.0 build -p opensesame-k8s-issuer`.

### 5.19a Client-facing API surfaces (CLI + MCP + TS client)
- **Owns:** `apps/cli/src/certmgr.rs` (module owned here; the `main.rs` `Commands` variant + dispatch
  staged for the Assembler if `main.rs` conflicts); MCP tool bodies appended in
  `apps/mcp-host/src/tools-read.ts`/`tools-act.ts` with Zod projection schemas;
  `packages/api-client/src/certmgr.ts` + spread into `src/index.ts`; the `opensesame cert agent`
  daemon-renewal watch subcommand (config file, machine-identity auth, file outputs with octal
  perms, renew-before, post-hooks).
- **Detail:** CLI verb tree over CA/policy/profile/app/cert/discovery/alert/approval/signer/sync
  management; secret material only behind `--reveal`/`--out-dir`; human table vs `--output json`.
  MCP: read tools for inventory/dashboard/CA/policy/profile/discovery/approval-list (Zod-projected,
  never key material); act tools only for non-secret management ops; issuance/signing/export stay
  human ceremony (webmcp/mcp excluded, §4.6). Add every new CLI source file to `CLI_SOURCES` in
  `apps/cli/tests/capability_parity.rs`. Tool names staged for `hostTools` (Assembler) and registered
  with projection schemas.
- **Reuse:** `apps/cli/src/certs.rs`, `apps/mcp-host/src/tools-act.ts` `cert_issue`,
  `packages/api-client/src/certs.ts` as templates.
- **Done:** `cargo +1.88.0 test -p opensesame-cli`; `pnpm --filter @opensesame/mcp-host test`;
  `pnpm --filter @opensesame/api-client test`; `apps/mcp-host/src/registry-parity.test.ts` green
  after Assembler wiring.

### 5.19b Certificates dashboard UI (Pages)
- **Owns:** `apps/pages/src/sections/certmgr/**` (a new top-level `Certificates` section) and its
  panels; `apps/pages/src/lib/certmgr.ts` (data seams calling `hostFetch`); co-located `*.test.tsx`;
  WebMCP read-only tool bodies in `apps/pages/src/webmcp/tools.ts` (SECTIONS/SECTION_PATHS staged for
  the Assembler).
- **Detail:** mirror Infisical's nav — Dashboard (stat cards Total/Active/Expiring/Expired/Revoked +
  by-enrollment/by-algorithm/by-CA + expiration timeline + activity trend, from
  `/api/v1/certmgr/dashboard`), Inventory (search/filter/columns + detail drawer), Discovery (Jobs +
  Installations tabs), Approval Requests (Application + Signing tabs), Applications, Code Signing →
  Signers, Certificate Authorities, Certificate Policies, Certificate Profiles. Use the
  `SettingsSection.tsx` category/panel/slot pattern and the `AppShell.tsx` `SECTIONS` mechanism. No
  new heavy chart dep unless already in the tree.
- **Reuse:** `apps/pages/src/sections/SettingsSection.tsx`, `apps/pages/src/lib/certs.ts`,
  `apps/pages/src/components/AppShell.tsx`.
- **Done:** `pnpm --filter @opensesame/pages test`; `apps/pages/src/webmcp/registry-parity.test.ts`
  green after Assembler wiring.

### 5.20 Assembler & verification swarm
- **Owns (exclusively) the shared files:** `apps/gateway/src/routes/mod.rs` (mount every §4.2 route
  with body limit + `// ADR 006x:` comment), `apps/gateway/src/app_state.rs` (new fields for the
  lifecycle + discovery actors + shared handles, initialized in `build()`), `apps/gateway/src/main.rs`
  (spawn the new actors alongside the existing four; ordering pacts in `mod pact_coverage` for the
  consequential new routes), `api/openapi/openapi.yaml` + `apps/gateway/src/routes/contract.rs`
  allowlist, `packages/capability-registry/src/index.ts` (all §4.6 rows) + run the registry
  `generate` script, `apps/mcp-host/src/tools.ts` `hostTools`, `apps/pages/src/components/AppShell.tsx`
  `SECTIONS` + `apps/pages/src/webmcp/tools.ts` `SECTION_PATHS`, `.env.schema` (all new knobs),
  `AGENTS.md:220` ADR-range bump, root `Cargo.toml` workspace-member list for the new crates.
- **Detail:** apply the pre-specified wiring and staged diffs from each swarm's PR body, then drive
  the §6 matrix to green, fixing only integration seams (never rewriting another swarm's logic; a
  real logic defect is reported to the owning swarm or amended in §4). Runs last only because it
  consumes exported symbols — it does not gate the others' development.
- **Done:** the entire §6 matrix green.

---

## 6. Validation matrix

### 6.0 Test-type contract — every swarm delivers all seven

This repository already standardizes seven test types, each with existing infrastructure and a
naming convention. A swarm's work is **not done** until it has delivered every type that applies
to its surface. Study the cited exemplar before writing; match its idiom rather than inventing one.

| Type | Rust infrastructure / exemplar | TypeScript infrastructure / exemplar |
|---|---|---|
| **Atomic unit** | inline `#[cfg(test)] mod tests` per module — e.g. `apps/gateway/src/rotation_scheduler.rs` | co-located `*.test.ts(x)` |
| **Snapshot / characterization** (the repo's [Verify](https://github.com/VerifyTests/Verify) equivalent) | **`insta` 1.43.2** (workspace dev-dep, `features = ["redactions", "json"]`) — `crates/kdbx-bridge/tests/snapshots/*.snap`, `crates/provider-bitwarden/tests/snapshots/*.snap`, `crates/human-vault` `envelope_wire_shape_is_pinned` | Vitest snapshots + `__snapshots__/` — `packages/audit/src/__tests__/redact.characterization.test.ts`, `apps/pages/src/lib/vault/import/formats/kdbx.characterization.test.ts`, `*.approval.test.ts` |
| **Contract / pact** | `pact` test modules; route↔spec test `apps/gateway/src/routes/contract.rs` | `*pact.test.ts` — `packages/database/tests/pact.test.ts`, `packages/redteam/src/structural.pact.test.ts` |
| **Chaos** | `crates/invoke-through/tests/chaos.rs` | `*.chaos.test.ts` — `apps/control-plane/src/__tests__/pact-chaos.test.ts`, `apps/pages/src/lib/guest-auth.chaos.test.ts` |
| **Fuzz** | `fuzz/fuzz_targets/*.rs` + `fuzz/Cargo.toml` — model `certificate_request.rs`; `pnpm audit:fuzz` | Jazzer.js — `packages/fuzz`, `pnpm test:fuzz` |
| **Behavior / BDD** | `tests/*behavior*.rs` with given/when/then test names | `*.behavior.test.ts` — `apps/pages/src/lib/guest-login.behavior.test.ts` |
| **Property** | `proptest` (workspace dev-dep) | fast-check where already used |

**What each type must cover for this feature.**

- **Snapshot/characterization** pins wire shapes so drift becomes a visible diff. Mandatory
  subjects: the applied SQL schema (query `sqlite_master` after migration, normalize to sorted
  JSON — this documents the delivered schema and catches accidental drift); normalized JSON
  projections of issued root/intermediate/leaf certificates (extensions, KU/EKU, basic
  constraints, CDP/AIA); `PolicyViolation` message lists per preset; parsed `CrlFacts` /
  `OcspRequestFacts`; every HTTP route's success and error response bodies; each external-CA and
  sync-destination adapter's outbound request payload; the CloudEvents alert envelope. **Always
  redact nondeterministic fields** (serials, timestamps, key bytes) with `insta` redactions, and
  **never snapshot private key material.**
- **Contract/pact** pins cross-layer agreements that break silently: enum serde strings against
  the DDL `CHECK` value sets (§4.1/§4.4 — storage round-trips these as TEXT); the `seal_scopes`
  constant set (§4.5 — a renamed scope breaks decryption of existing data); `MIGRATIONS` array
  append-only ordering; route↔OpenAPI agreement via `routes/contract.rs`; capability-registry
  parity.
- **Chaos** proves graceful degradation, and for concurrent state it proves *security*
  properties: racing `consume_scep_challenge` / `consume_acme_nonce` on one token (exactly one
  winner); racing `increment_signature_count` at the cap (the cap must never be exceeded); racing
  `transition_approval_request` from two approvers (one winner); truncated/oversized/deeply-nested
  parser inputs; a destination that hangs, resets, or returns malformed data mid-sync; a rolled
  back transaction leaving no partial rows.
- **Behavior/BDD** describes operator-visible outcomes in given/when/then names — issuance under a
  policy, refusal at a path-len boundary, revocation reflected in both CRL and OCSP, renewal
  preserving metadata and re-running syncs, an approval advancing step-by-step, cross-org
  invisibility.
- **Fuzz** targets every parser reachable from untrusted input: CSR, PKCS#12, CRL, OCSP request,
  SCEP CMS, ACME JWS, and the certificate-filter/SQL construction path (which must additionally
  assert that no input ever appears inline in generated SQL).

**Gate registration is part of the work.** New security-critical files must be added to the
`test:mutation:rust` file list in the root `package.json` (currently covers
`apps/gateway/src/cert_issuers/model.rs` among others) — at minimum the policy evaluator, the
bundle/PKCS#12 codec, the approval/scope evaluator, and the revocation builders, since surviving
mutants there are the ones that matter. The Rust coverage gate runs workspace-wide
(`--fail-under-lines 69 --fail-under-functions 67`), so every swarm reports
`cargo +1.88.0 llvm-cov -p <crate> --summary-only` for its own crate and must not drag the
workspace below the floor; new security-critical code should land well above it. TS packages must
keep the `ts-coverage-gate.mjs` floors (94/88/94/95, plus the 50% per-package lines floor) and
must use `vitest run` as their `test` script or the gate warns.

### 6.1 Global gate

Green before any PR merges:

```
pnpm verify                                   # lint + anti-slop + rust-lint + clippy + test:all + workspace cargo test + battle-test
cargo +1.88.0 test --workspace --all-targets  # every Rust crate incl. the new ones
pnpm test:coverage                            # TS floors 94/88/94/95 + 50% per-pkg; Rust 69/67
pnpm test:mutation                            # Stryker (TS) + cargo-mutants (Rust), incl. newly registered files
pnpm audit:fuzz                               # cargo-fuzz short pass over all targets
pnpm audit:clippy && pnpm audit:semgrep && pnpm audit:cargo-audit && pnpm audit:gitleaks
```

Parity suites that must stay green: `apps/cli/tests/capability_parity.rs`,
`packages/cli/src/capability-parity.test.ts`, `apps/mcp-host/src/registry-parity.test.ts`,
`apps/mcp-client/src/registry-parity.test.ts`, `apps/pages/src/webmcp/registry-parity.test.ts`,
`apps/pwa/src/webmcp.test.ts`, `packages/capability-registry/src/registry.test.ts`,
`packages/redteam/src/structural.pact.test.ts`.

New fuzz targets registered in `fuzz/Cargo.toml`: CSR parser, PKCS#12 parser, SCEP CMS parser,
ACME JWS parser — exercised by `pnpm audit:fuzz` short pass.

**Honest validation-limits table** (also in `docs/validation/certificate-manager.md`):

| Area | Validation depth in CI |
|---|---|
| PKI engine, policy, CRL, OCSP, revocation | Full unit + property + fuzz, hermetic |
| CA mgmt, inventory, apps, approvals, renewal, alerts, discovery | Full unit + contract + adversarial, hermetic (in-process listeners/fixtures) |
| ACME server, EST, SCEP | Hermetic interop (in-crate client / recorded fixtures) |
| External CA adapters | Recorded-fixture contract tests only — no live third-party calls |
| HSM client | SoftHSM2 integration if present, else mock-token unit test (recorded skip) |
| PKCS#11 provider cdylib | Builds + unit tests against a Sign API double |
| Windows KSP | Build-only cross-compile (or documented compile guard if the target toolchain is absent) |
| K8s issuer | Reconcile against a `kube` fake client — no live cluster |
| Sync SSH/WinRM executors | Feature-gated, unit-tested against fakes |

---

## 7. File-ownership and conflict protocol

- **No two swarms write the same file.** The only files touched by more than one swarm are the
  shared files, which are touched **only** by the Assembler (§5.20). Build swarms that need a line
  in a shared file export the required symbol from their owned module and **stage the shared-file
  diff as a fenced code block in their PR body** for the Assembler to apply — so every build swarm's
  branch is independently buildable except for the final wiring.
- **Reserved numbers:** migration `0016` (Persistence); ADRs `0066`–`0072` (ADR swarm). No other
  swarm allocates a migration or ADR number without amending §3/§4.1.
- **Interface drift:** a swarm that finds a §4 contract wrong amends the relevant §4 subsection in
  its PR and calls it out in the PR body — it never invents an unlisted interface silently.

| Owner | Owned paths (new unless noted) |
|---|---|
| §5.1 ADR & docs | `docs/adr/0066..0072-*.md`, `docs/validation/certificate-manager.md`, rows in `docs/security/threat-model.md`, `docs/security/key-hierarchy.md`, `docs/standards-matrix.md`, `docs/competitors/infisical.md` |
| §5.2 Persistence | `migrations/0016_certificate_manager.sql`, additions to `crates/storage/src/lib.rs` |
| §5.3 PKI engine | `crates/pki-core/**` |
| §5.4 Policy/profile | `crates/pki-core/src/policy*`, `apps/gateway/src/routes/certmgr_policy.rs`, `certmgr_profile.rs` |
| §5.5 Revocation | `crates/pki-core/src/revocation*`, `apps/gateway/src/routes/revocation.rs` |
| §5.6 CA routes | `apps/gateway/src/routes/certmgr_ca.rs` |
| §5.7 Inventory | `apps/gateway/src/routes/certmgr_inventory.rs` |
| §5.8 Apps/access | `apps/gateway/src/routes/certmgr_app.rs`, `certmgr_roles.rs` |
| §5.9 Approvals | `apps/gateway/src/routes/certmgr_approvals.rs`, approval engine module |
| §5.10 Lifecycle | `apps/gateway/src/cert_lifecycle.rs`, manual-renewal module |
| §5.11 Discovery | `apps/gateway/src/routes/certmgr_discovery.rs`, `apps/gateway/src/cert_discovery.rs` |
| §5.12 Alerting | `apps/gateway/src/routes/certmgr_alerts.rs`, `apps/gateway/src/cert_alerts.rs` |
| §5.13 ACME server | `apps/gateway/src/routes/acme_server.rs`, acme_server module |
| §5.14 EST/SCEP | `apps/gateway/src/routes/est_server.rs`, `scep_server.rs`, `crates/scep/**` |
| §5.15 Code signing | `apps/gateway/src/routes/certmgr_signers.rs`, `crates/pkcs11-provider/**`, `crates/windows-ksp/**` |
| §5.16 External CA/HSM | `apps/gateway/src/routes/certmgr_connectors.rs`, `apps/gateway/src/cert_issuers/external/**`, `crates/hsm-client/**`, catalog rows |
| §5.17 Syncs | `apps/gateway/src/routes/certmgr_syncs.rs`, `apps/gateway/src/cert_syncs/**` |
| §5.18 K8s issuer | `apps/k8s-issuer/**` |
| §5.19a Client API | `apps/cli/src/certmgr.rs`, `packages/api-client/src/certmgr.ts`, tool bodies in `apps/mcp-host/src/tools-read.ts`/`tools-act.ts` |
| §5.19b Pages UI | `apps/pages/src/sections/certmgr/**`, `apps/pages/src/lib/certmgr.ts`, WebMCP tool bodies |
| §5.20 Assembler | `routes/mod.rs`, `app_state.rs`, `main.rs`, `api/openapi/openapi.yaml`, `routes/contract.rs`, `packages/capability-registry/src/index.ts`, `apps/mcp-host/src/tools.ts`, `apps/pages/src/components/AppShell.tsx`, `apps/pages/src/webmcp/tools.ts` (SECTION_PATHS), `.env.schema`, `AGENTS.md`, root `Cargo.toml` |

---

## 8. Dispatch summary

Dispatch §5.2 and §5.3 first (Persistence and PKI engine export the substrate everyone links);
they have no cross-dependencies and run concurrently. Dispatch §5.4–§5.18 and §5.19a/b
concurrently — each codes against §4, not another swarm's output, stubbing any not-yet-present
accessor against its §4.3 signature. Dispatch §5.1 (docs) concurrently. Dispatch §5.20 (Assembler)
last, consuming the exported symbols and staged shared-file diffs, then drive §6 to green. Given
§4, every swarm can be one-shotted in parallel.
