# Audit — 2026-08-21 — certificate key custody and issuance ceremony

Status: Remediated locally; live provider conformance remains unclaimed

## Scope

This review traced and repaired the certificate flow through
`apps/gateway/src/dev_pki.rs`, `apps/gateway/src/routes/certs.rs`,
`migrations/0009_host_kv.sql`, `crates/connection-broker/src/crypto.rs`, and
the Pages certificate editor/model/client.

## Findings

| Severity | Current finding | Required repair |
| --- | --- | --- |
| Critical | Plaintext root CA persistence | Fixed: sealed, organization/AAD-bound authority storage; verified legacy migration; production refusal without the Host sealing key. |
| High | Editable PEM/private-key ceremony | Fixed: Pages accepts names, SANs, IPs, and lifetime; Host generates the leaf key and CSR. |
| High | Lost-response reissuance and broad key retrieval | Fixed: encrypted expiring delivery, actor binding, exact idempotent retry, and post-vault acknowledgement deletion. |
| High | Trust downgrade after external issuer failure | Fixed: persisted external default, explicit override, typed failure, and no private-CA fallback. |
| Medium | Non-transactional `host_kv` issued-record list | Fixed for persistent mode with transactional authority/request/delivery/issued tables. The development-only ephemeral CA retains bounded process-local metadata. |

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

## Local closure evidence

The focused suites demonstrate sealed AAD purpose separation, removal of the
legacy plaintext CA after verified migration, exact idempotent delivery retry,
acknowledgement deletion, expiry and cross-tenant/actor refusal, external
failure without private-CA downgrade, strict request bounds, generated P-256
leaf keys, ACME endpoint/challenge refusal, and DNS cleanup success/failure.

- `cargo +1.88.0 test -p opensesame-gateway cert --no-fail-fast`: 16 passed;
- `cargo +1.88.0 test -p opensesame-storage certificate --no-fail-fast`: 5 passed;
- `cargo +1.88.0 test -p opensesame-connection-broker certificate --no-fail-fast`: 2 passed;
- focused Pages certificate behavior/contract tests: 36 passed; and
- strict Clippy over gateway, storage, and connection broker: passed.

No live Let's Encrypt, ZeroSSL, or Cloudflare credential was used. This is not
a claim of provider, WebPKI, or general RFC 8555 conformance.
