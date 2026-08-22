# ADR 0052: Automatic certificate authority selection and key custody

Status: Accepted; implementation pending
Date: 2026-08-21
Related: ADR 0005, 0017, 0032, 0039

## Context

The Host already generates an ECDSA P-256 private CA and leaf key in
`apps/gateway/src/dev_pki.rs`. The issuance request accepts names and lifetime,
not caller-provided PEM. However, `apps/gateway/src/routes/certs.rs` serializes
the CA certificate and private key together in the generic, explicitly
non-secret `host_kv` table under `certs.dev_ca`. Pages then presents editable
Certificate, Private key, and Issuing CA fields, so the normal ceremony still
looks like manual PKI and permits pasted key material.

The current response returns a generated leaf key and stores only issuance
metadata on the Host. It has no durable one-time delivery acknowledgement,
organization issuer selection, external CA order state, or encrypted CA
custody. This ADR specifies the repaired behavior; it does not claim that the
current implementation already provides it.

## Decision

### Ceremony and issuer selection

The normal user supplies only the certificate use: primary hostname and,
optionally, SANs, IP addresses, lifetime, and an advanced issuer choice.
OpenSesame generates the ECDSA P-256 leaf key and CSR. Normal issuance APIs and
UI do not accept certificate PEM, leaf private-key PEM, or an issuing CA.
Importing an existing certificate, if retained, is a separately named import
operation and never an issuance fallback.

Issuer resolution is deterministic:

1. an eligible issuer explicitly selected for this request;
2. the organization's explicitly configured external default issuer;
3. the OpenSesame private CA when no external default is configured.

An external default is a ConnectionRef-backed organization setting, not the
first connection returned by a list operation. An unavailable or failed
external issuer returns a typed failure naming safe remediation. It never falls
back to the OpenSesame CA because that would change the certificate's trust
semantics without consent. Host owns issuance and connection authority;
Identity remains a separate API and database boundary.

Every result carries one of these policy-visible trust labels:

- `private`: OpenSesame private CA; clients must install its root explicitly;
- `public`: a configured public ACME CA such as Let's Encrypt or ZeroSSL;
- `origin_only`: Cloudflare Origin CA; valid only for the Cloudflare-to-origin
  hop and not represented as publicly browser-trusted.

Cloudflare DNS is a DNS-01 challenge connection, not an issuer. Cloudflare
Origin CA is a distinct `origin_only` issuer connection.

### Key custody and delivery

CA private keys, ACME account credentials and keys, external-account-binding
secrets, and sensitive order state are encrypted before database storage with
the existing Host sealing-key discipline. Ciphertexts use fresh nonces and
authenticated associated data binding organization, authority/order ID,
record kind, and format version. Public certificates, digests, status, issuer
identity, expiry, and trust labels may be stored as ordinary metadata.

Production certificate routes fail closed unless both durable storage and a
valid sealing key are available. There is no generated production sealing key,
plaintext fallback, or in-memory-only authority. Local development may create
an explicitly labelled ephemeral private CA, but must not persist its private
key without sealing.

Leaf key material is retained only in an encrypted, expiring delivery record.
The authenticated creator may retrieve it once, save it to the encrypted local
vault, and acknowledge receipt. A successful acknowledgement or expiry deletes
the delivery ciphertext. Retries use the original idempotency key and request
digest; they do not mint extra certificates or expose material to another
principal. Logs, audit events, receipts, URLs, and error text contain only IDs,
digests, issuer labels, names, lifetimes, and outcomes—never private keys,
account credentials, challenge tokens, or certificate payloads.

### ACME profile

Public issuance implements RFC 8555 through exactly
`instant-acme = "=0.8.5"`, whose published API provides RFC 8555 accounts,
serializable account credentials, External Account Binding, orders,
revocation, and ACME Renewal Information. The dependency remains isolated in
the Host issuer adapter; OpenSesame does not implement JWS or ACME account
cryptography itself.

The supported profile is DNS-01 only. DNS mutation uses a narrowly scoped,
sealed connection such as Cloudflare DNS, waits within bounded propagation and
order deadlines, and attempts challenge-record cleanup on every terminal path.
Let's Encrypt needs no secret supplied during certificate issuance. ZeroSSL EAB
is configured once in its issuer connection. HTTP-01, TLS-ALPN-01, arbitrary
ACME directory URLs, and automatic certificate deployment are refused as
unsupported rather than partially implemented.

References:

- [RFC 8555: Automatic Certificate Management Environment](https://www.rfc-editor.org/rfc/rfc8555)
- [`instant-acme` 0.8.5 API](https://docs.rs/instant-acme/0.8.5/instant_acme/)
- [`AccountCredentials` persistence contract](https://docs.rs/instant-acme/0.8.5/instant_acme/struct.AccountCredentials.html)

### Legacy migration

The SQL migration only adds the sealed authority, order, delivery, and public
issuance-metadata storage. Moving `certs.dev_ca` is an application-level,
exclusive, idempotent migration because SQL cannot safely obtain the runtime
sealing key or validate the key/certificate pair.

On startup or first certificate use, the application:

1. acquires an exclusive migration lease;
2. refuses certificate service if durable storage or sealing is unavailable;
3. reads and validates the legacy certificate/key pair without logging it;
4. seals it into the organization authority record;
5. decrypts and verifies the new record and key/certificate match;
6. deletes `host_kv['certs.dev_ca']` in the same database transaction; and
7. records only a migration version and public digest.

A crash rolls back to either the untouched legacy row or the verified sealed
row; retries converge on the sealed row. Conflicting legacy and sealed records
fail closed for operator review. Mixed old/new Gateway versions are not safe
during this security migration, so rollout requires a single-writer stop and
restart. Before migration, rollback may use the old binary. After plaintext
deletion, rollback is forward-fix or restoration of an authorized pre-migration
database backup; the application never recreates plaintext for compatibility.

## Consequences

- The common path becomes one create action instead of a manual PEM ceremony.
- OpenSesame remains useful without a third-party CA, while configured public
  and origin-only issuers preserve their distinct trust semantics.
- External-issuer outages are visible and cannot cause trust downgrade.
- Leaf-key delivery requires durable transient storage and acknowledgement,
  adding state but preventing broad or repeated key retrieval.
- Existing plaintext CA installations require coordinated migration and cannot
  safely roll back to an old writer after migration.

## Required evidence before claiming completion

Implementation must prove automatic P-256 generation, strict request schemas,
issuer precedence and no-downgrade behavior, sealed-record AAD and key rotation,
legacy migration retry/crash behavior, tenant and actor isolation, one-time
delivery under concurrent retrieval, redaction, DNS cleanup, and production
startup refusal. ACME tests use deterministic local fixtures and no personal
cloud credentials. Passing those tests establishes this implementation profile,
not general ACME, CA, or provider conformance.
