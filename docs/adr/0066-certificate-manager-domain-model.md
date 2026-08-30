# ADR 0066 — Certificate Manager domain model

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0005 (ConnectionRef / authority handles),
ADR 0017 (host/client product topology), ADR 0032 §3 (catalog is data),
ADR 0039 (outbox and the backup actor),
ADR 0052-cert ([automatic certificate authority selection](0052-automatic-certificate-authority-selection.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md),
[connector/hook architecture](0065-connector-hook-architecture.md))
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

ADR 0052-cert made certificate issuance a one-action ceremony: the caller
supplies a hostname, optional SANs and a lifetime; the Host generates the P-256
leaf key and CSR; the issuer is resolved deterministically (explicit selection →
organization external default → the OpenSesame private CA); and every result
carries a trust class. That decision is intact and this ADR does not disturb it.

What it left unbuilt is everything *around* a certificate. The live surface is a
single self-signed development root (`apps/gateway/src/dev_pki.rs`), four global
issuance constants in `apps/gateway/src/cert_issuers/model.rs`, three tables
(`certificate_authorities`, `certificate_issuance_requests`,
`issued_certificates` from `migrations/0013_certificate_issuance.sql`), and four
routes in `apps/gateway/src/routes/certs.rs`. There is no CA hierarchy, no way
to say "certificates for this service must have these constraints", no notion of
who inside an organization may operate a given certificate population, no
inventory of certificates OpenSesame did not itself mint, and no linkage between
a certificate and its successor. `docs/competitors/infisical.md` records that
honestly today as "(dev TLS)".

The gap is not a missing feature; it is a missing **domain model**. Each absent
feature — policies, applications, discovery, renewal, revocation, syncs, code
signing — needs the same set of nouns to hang off. Building them against
ad-hoc shapes would produce seven incompatible half-models. This ADR fixes the
nouns once, so that ADRs 0067–0072 and the implementation swarms can each name
the same objects.

## Decision

### 1. One object chain: CA → policy → profile → application → enrollment config → certificate

The Certificate Manager has exactly one spine, and every issuance path (API,
ACME, EST, SCEP, UI) walks it:

```
certificate_authorities   root or intermediate; owns a signing key
        │
certificate_policies      constraints: what a certificate may contain
        │
certificate_profiles      a CA + a policy + defaults; the issuable unit
        │
pki_applications          a service-shaped workspace with members
        │
enrollment_configs        (application × profile × method) + method secret
        │
issued_certificates       the inventory row, with renewal linkage
```

A certificate is never issued from a policy directly, nor from a CA directly on
the management surface: it is issued **from a profile**, optionally scoped to an
application through an enrollment config. The existing `/api/v1/certs/*` routes
keep their current profile-free behavior for backward compatibility; the new
`/api/v1/certmgr/*` namespace is the one that requires the chain.

The row shapes land in the forthcoming `migrations/0016_certificate_manager.sql`
and the accessors in `crates/storage/src/lib.rs`; the serde documents for the
`*_json` columns land in the forthcoming `crates/pki-core` `types` module.

Gate: `cargo +1.88.0 test -p opensesame-storage`

### 2. Policies and profiles are separate objects, deliberately

The obvious alternative — one object carrying both constraints and defaults —
was rejected. Policy and profile answer different questions and change on
different schedules:

- A **policy** is a pure constraint document: which subject attributes are
  permitted or required, which SAN types, which key and signature algorithms,
  which key usages and extended key usages, whether `basicConstraints:CA` is
  forbidden/allowed/required, and a maximum validity. It names no CA and mints
  nothing. It is the object a security owner writes once and rarely edits.
- A **profile** is `(issuer, policy, defaults)`: a specific CA (or the
  `self_signed` issuer type), exactly one policy, and the default field values
  used when a request omits them. It is the object an operator points a client
  at, and it is what an enrollment endpoint is scoped to.

The separation buys reuse in the direction that actually occurs: one
"internal TLS server" policy is shared by a dozen profiles that differ only in
which intermediate signs them or what default TTL they carry. Merging them would
force the constraint text to be copied per CA, and every constraint tightening
would become a dozen edits with a dozen chances to miss one.

This is the ADCS *certificate template* split, arrived at from the same
pressure: a template pins the extension and constraint shape, an enrollment
policy binds it to an issuing CA and an audience. We keep the split and drop the
Windows-specific enrollment-permission model, because membership belongs to the
application object (§3), not to the template.

Policy evaluation is three-state per field, so "unset" and "explicitly empty"
are different: unset means allow-anything, `mode: "allow"` with an empty value
list means deny-everything, and a populated list is a whitelist. Profile
defaults are validated against the policy at **write** time as well as issue
time, so a profile cannot be saved carrying a default its own policy forbids.
The evaluator lands in the forthcoming `crates/pki-core` `policy` module; the
routes in the forthcoming `apps/gateway/src/routes/certmgr_policy.rs` and
`certmgr_profile.rs`.

Gate: `cargo +1.88.0 test -p opensesame-pki-core`

### 3. Applications are workspaces; membership layers over `Caller`

An **application** is a per-service workspace (`slug`, display name,
description) owning enrollment configs, alerts, approval policies, and the
certificates issued through them. Members are principals — session subjects,
machine identities, or group references — carrying one of three roles:

| Role | May |
|---|---|
| `admin` | everything in the application, including membership and enrollment configs |
| `operator` | request/renew/revoke certificates and read everything |
| `auditor` | read only |

These roles are **layered over**, not a replacement for, the existing caller
model in `apps/gateway/src/middleware/auth.rs`. `resolve_caller` still
establishes who the caller is and which organization they are in
(`Caller::in_organization`); an organization owner or admin
(`Caller::can_configure_integrations`) is always treated as product-admin and
therefore admin of every application in that organization. The new helper
(forthcoming `apps/gateway/src/routes/certmgr_roles.rs`) exposes
`require_app_role(state, headers, application_id, minimum)` and its signer
sibling, and every certmgr handler calls it before touching `st.db`.

Two behaviors are load-bearing. First, a caller who is not a member of an
application gets **404, not 403** — existence is not disclosed to non-members,
matching the cross-org isolation posture already asserted by
`adversarial_ephemeral_history_isolated_between_organizations` in
`apps/gateway/src/routes/certs.rs`. Second, roles never widen organization
scope: an application member in org A gains nothing in org B, because every
table carries `organization_id` and every accessor is org-scoped.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 4. Inventory has three sources and explicit renewal linkage

`issued_certificates` becomes the inventory table for every certificate
OpenSesame knows about, discriminated by `source`:

- `issued` — minted by OpenSesame through a profile. Managed-key certificates
  additionally carry sealed key material; CSR-mode certificates carry none.
- `imported` — supplied by a human through the import ceremony as PEM or a
  PKCS#12 keystore. OpenSesame validates and normalizes the chain (generalizing
  `normalize_external_certificate` in `apps/gateway/src/cert_issuers/model.rs`)
  but did not mint it and may hold no private key for it.
- `discovered` — observed on the network by a TLS discovery scan. A discovered
  row starts as an *installation* record and is promoted into inventory only by
  an explicit import action, so a scan can never silently populate the
  authoritative list.

`source` is not a status. Status (`active`, `renewed`, `revoked`, `expired`,
`pending`) is validated in Rust rather than by a SQL `CHECK`, because the
applied `0013` constraint must not be rewritten (migrations are append-only).

Renewal is a **link, not an overwrite**. A renewal creates a new row and sets
`renewed_from_id` on the successor and `renewed_by_id` on the predecessor; the
predecessor transitions to `renewed` and its certificate stays valid until it
expires or is revoked. One renewal per certificate is enforced, so the chain is
a list rather than a tree and "which certificate replaced this one" has exactly
one answer. Custom metadata key-values are carried across a renewal by the
lifecycle actor, because metadata is how operators correlate a certificate to
their own systems and losing it at renewal would silently break those
correlations.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 5. Every mutating certmgr route emits an outbox audit event

Auditability is a property of the model, not a feature bolted on per route. Each
mutating `/api/v1/certmgr/*` handler appends a host-plane outbox event in the
**same transaction** as its state change, using the `append_outbox_tx` pattern
established in `apps/gateway/src/github_webhook.rs`, with event type
`certmgr.<object>.<verb>` (`certmgr.ca.created`, `certmgr.certificate.revoked`,
`certmgr.signer.signed`, …) and a non-secret payload projection. Same
transaction means there is no window in which state changed and the audit record
did not, and no compensating "audit failed but the write landed" case to reason
about. Code signing additionally keeps a per-signer activity ledger
(ADR 0070 §6), because a signature is an event worth reading independently of
the certificate lifecycle.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 6. Agent-surface disposition is decided per capability, at the model level

ADR 0065's parity rule applies unchanged: every user-facing capability gets a
`packages/capability-registry/src/index.ts` entry that maps or ADR-excludes each
of `cli`, `pwa`, `mcp_host`, `mcp_client`, `webmcp`. The model-level rule this
ADR fixes, so individual swarms do not relitigate it:

- **Read** capabilities (`certmgr.cert.list`, `certmgr.dashboard.read`,
  `certmgr.ca.list`, policy/profile/discovery/approval listings) map to
  MCP/WebMCP read tools behind Zod projection schemas.
- Anything that **touches key material or mints trust** — issuance, import,
  export, signing, CA creation and renewal — is human ceremony, excluded from
  WebMCP with a reason and an ADR citation, exactly as `certs.issue` is today.
- **Syncs and connectors** are excluded from *every* agent surface
  (ADR 0069 §2(d), ADR 0071 §5): an agent must not be able to cause a
  certificate and its key to be pushed anywhere, nor to reach an HSM PIN.

`assertsNoSecretTools` (`apps/mcp-host/src/tools.ts`) and `assertsNoSecretNames`
(`packages/capability-registry`) remain the mechanical backstop.

Gate: `pnpm --filter @opensesame/capability-registry test`

### 7. Positioning: the "(dev TLS)" qualifier is retired

`docs/competitors/infisical.md` currently describes OpenSesame's certificate
capability as `/api/v1/certs` + `opensesame cert` + Pages certificate items
**(dev TLS)**. With the chain in §1 and ADRs 0067–0072 built, that qualifier is
wrong: OpenSesame manages a CA hierarchy, policy-constrained issuance, four
enrollment protocols, revocation distribution, and an inventory. This ADR
supersedes that positioning and directs the competitor doc to state the real
scope alongside the honest exclusions of §8.

What this ADR does **not** supersede is ADR 0052-cert's issuance mechanics:
generated keys only on the normal path, no pasted PEM as an issuance fallback,
deterministic issuer resolution, no external-to-private trust downgrade, sealed
custody with organization/purpose AAD, and one-time acknowledged leaf delivery.
Those remain in force and every new enrollment path inherits them.

Gate: `pnpm --filter @opensesame/pages test`

## Non-goals and roadmap

Recorded so each exclusion is a decision with a stated reason, not an omission.
Where the reason is a stack or environment constraint rather than a product
judgement, it is a roadmap item and says so.

### N1. Post-quantum ML-DSA certificate authorities — roadmap

ML-DSA-44/65/87 CA keys are not built. The pinned issuance stack
(`rcgen` 0.13 on Rust 1.88) has no ML-DSA X.509 path, and hand-rolling
signature-algorithm encoding for a post-quantum scheme inside our own CA is
precisely the NIH protocol code ADR 0008 tells us not to write. Revisit when
RustCrypto or `aws-lc-rs` ships stable ML-DSA X.509 support at a version this
workspace can pin. The `key_algorithm` column and the `Signer` trait
(ADR 0071 §4) are already open enums, so adding an algorithm is an additive
change, not a re-model.

### N2. Microsoft ADCS via MS-WCCE / NTLM — excluded

MS-WCCE is DCOM/RPC over an NTLM- or Kerberos-authenticated channel. Reaching it
requires a Windows RPC stack the gateway does not have and would not gain
cheaply, and NTLM credential handling inside the authority plane is a custody
surface we decline. The Azure ADCS **HTTPS web-enrollment** adapter (forthcoming
`apps/gateway/src/cert_issuers/external/azure_adcs.rs`, a broker-fenced sibling
of the existing adapters in `apps/gateway/src/cert_issuers/`) covers the
reachable part of the same deployment through an ordinary HTTPS path.
This is an exclusion, not a roadmap item: the transport, not the feature, is the
objection.

### N3. SCEP Intune challenge validation — roadmap

Validating an Intune-minted SCEP challenge requires a live Microsoft Graph
tenant to call, which no hermetic test can supply and no CI gate can honestly
assert. We build the seam instead: the authenticated dynamic-challenge mint
endpoint (`POST /scep/{profileId}/challenge`, ADR 0068 §4) is exactly where an
Intune adapter would attach. Revisit if a fixture-recordable Graph contract and
an operator willing to validate it against a real tenant both exist.

### N4. Cloud-provider and filesystem certificate discovery — roadmap

Network TLS discovery is built (jobs, targets, installations, fingerprint
tracking across scans). Enumerating certificates from cloud provider APIs or
from a host filesystem is not. It is a roadmap item at parity with the
competitor, which lists the same capability as planned rather than shipped. The
`discovery_installations` shape is source-agnostic, so a second discovery source
adds a producer, not a schema.

### N5. Terraform provider — excluded

No Terraform surface exists anywhere in this repository, and adding one would
mean a Go module, a separate release channel, and a second registry to keep in
parity with `packages/capability-registry`. Under ADR 0065's parity model the
infrastructure-as-code surfaces are the REST API, the Host CLI (`opensesame
cert …`), and MCP — all of which are already parity-tested. An operator who
wants Terraform can drive the REST API from `http` or `external` resources
today. Revisit only if the parity model gains a way to include a
non-TypeScript, non-Rust surface without a second source of truth.

### N6. KMS, KMIP server, SSH certificate authorities, PAM — out of scope

These are separate products in the compared vendor's line-up, not parts of its
Certificate Manager, and they are separate concerns here too. OpenSesame's PAM
ceremonies live under ADR 0061 and its sealed-store/vault custody under
ADR 0037/0052-pm. Nothing in this ADR forecloses them; they simply are not
certificate-manager scope, and folding them in would make the object chain in §1
answer two unrelated questions.

## Consequences

- Seven feature areas can be built concurrently against one set of nouns, which
  is what makes the parallel swarm plan viable at all. The cost is that the
  schema in `0016_certificate_manager.sql` is large and lands before most of its
  consumers.
- The policy/profile split adds an object operators must understand before they
  can issue through the new namespace. The old `/api/v1/certs/issue` path stays
  as the zero-configuration entry point, so the floor does not rise for existing
  users.
- Application membership introduces a second authorization axis alongside
  organization role. Every certmgr handler now has two gates to get right rather
  than one; the shared `require_app_role` helper exists so there is exactly one
  implementation to review.
- Renewal-as-link means the inventory grows monotonically rather than mutating
  in place. Cleanup (delete N days past expiry, skipping certificates with
  active syncs) is therefore a required feature, not an optimization.
- The `(dev TLS)` retirement is a claim we now have to keep true. The validation
  doc (`docs/validation/certificate-manager.md`) carries the honest limits table
  so the positioning and the evidence stay attached to each other.
