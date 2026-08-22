# Audit — 2026-08-21 — certificate key custody and issuance ceremony

Status: Open until ADR 0052 is implemented and independently verified

## Scope

This review traced the certificate flow through
`apps/gateway/src/dev_pki.rs`, `apps/gateway/src/routes/certs.rs`,
`migrations/0009_host_kv.sql`, `crates/connection-broker/src/crypto.rs`, and
the Pages certificate editor/model/client. It records current source behavior
and the required repair; it is not evidence that the repair has landed.

## Findings

| Severity | Current finding | Required repair |
| --- | --- | --- |
| Critical | `load_or_create_ca` serializes `DevCa { cert_pem, key_pem }` into `host_kv['certs.dev_ca']`. Migration 0009 explicitly defines `host_kv` as not being a secrets vault, so a database read exposes the root signing key and every certificate that authority can impersonate. | Move authority material to tenant-bound authenticated encryption under a configured Host sealing key. Production certificate service must refuse startup/use without durable storage and sealing. Migrate the legacy row application-side, verify before deletion, and fail closed on conflict or partial migration. |
| High | Pages exposes editable Certificate, Private key, and Issuing CA textareas. Although the Host already generates a P-256 leaf key, the UI makes manual key supply part of the normal ceremony and allows pasted key material into the issuance-shaped record. | The normal ceremony accepts names, lifetime, and issuer policy only. Generate key/CSR automatically and keep any legacy import as an explicitly separate operation. |
| High | The issue response contains the leaf key, but there is no durable delivery handle, request digest, acknowledgement, expiry, or concurrent single-consumer enforcement. A lost response causes reissuance; future retries could accidentally broaden key retrieval. | Store leaf material only as an encrypted, expiring, actor-bound one-time delivery. Exact idempotent retry returns the same pending delivery; acknowledgement or expiry erases it. |
| High | There is no organization-scoped external issuer default or trust classification. Adding fallback naively would permit a failed public/origin issuer request to become a private-CA certificate. | Resolve explicit issuer, configured organization default, then internal CA only when no external default exists. Never downgrade after external selection. Return `private`, `public`, or `origin_only` trust labels. |
| Medium | The issued-record list is a read/modify/write JSON value in `host_kv`; it is not an atomic order, replay, delivery, or audit record and is capped by truncation. | Use durable transactional issuance/order metadata with unique request digest and idempotency constraints. Atomically record terminal outcome and delivery state. |

## Existing controls worth preserving

- `rcgen` generates the private CA and leaf keys with ECDSA P-256; callers do
  not submit a leaf key to the current Host issue endpoint.
- Leaf private keys are not added to the current issued-record metadata list.
- Certificate issuance requires an owner/admin Host session.
- `IssueBody` denies unknown fields and bounds leaf lifetime to 90 days.
- The connection broker already provides XChaCha20-Poly1305 sealing with fresh
  nonces and organization/record associated data. Certificate storage should
  reuse that key discipline rather than inventing cryptography.

These controls do not mitigate plaintext root-key persistence or the editable
Pages ceremony.

## Accepted remediation boundary

ADR 0052 defines the complete boundary:

- OpenSesame private CA is automatic when no external default is configured.
- A request-selected or organization-default external issuer is authoritative;
  its failure never silently falls back.
- Public ACME uses RFC 8555 DNS-01 only through exactly
  `instant-acme = "=0.8.5"`; account credentials, EAB, and order secrets are
  sealed. Cloudflare DNS is a challenge connection, while Cloudflare Origin CA
  is a separately labelled `origin_only` issuer.
- Leaf key delivery is encrypted, expiring, actor-bound, single-consumer, and
  absent from logs, audit, URLs, and ordinary metadata.
- Identity and Host remain separate; all CA and connection authority stays in
  Host.

No statement here claims general RFC 8555, Let's Encrypt, ZeroSSL, Cloudflare,
or CA conformance. Those claims require integrated protocol and adversarial
evidence.

## Closure evidence required

Do not mark this record closed until tests demonstrate:

- plaintext legacy migration, wrong-key/AAD refusal, crash retry, conflict
  refusal, key rotation, and no post-migration plaintext residue;
- production refusal without persistent storage or sealing;
- one winner under concurrent leaf-material retrieval, replay refusal,
  acknowledgement deletion, expiry cleanup, and cross-tenant/actor denial;
- issuer precedence, external-failure no-downgrade, and accurate trust labels;
- automatic P-256 key generation and rejection of caller-supplied PEM in normal
  issuance;
- ACME order replay/timeout and DNS propagation/cleanup failures using local
  deterministic fixtures; and
- secret scans over database fixtures, logs, audit events, URLs, errors, and
  snapshots.

At this audit point no implementation or validation command is reported as
passing for these remediations.
