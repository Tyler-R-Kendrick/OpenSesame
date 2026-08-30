# ADR 0067 — Revocation: CRL generation and an OCSP responder

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0052-cert
([automatic certificate authority selection](0052-automatic-certificate-authority-selection.md)),
ADR 0066 (Certificate Manager domain model), ADR 0071 (HSM connectors)
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

OpenSesame's private CA already sets the `CrlSign` key usage
(`apps/gateway/src/dev_pki.rs`) and nothing else about revocation exists: no
revocation record, no CRL, no distribution point in issued certificates, no
responder. A certificate issued by the OpenSesame CA today cannot be un-trusted
except by waiting for it to expire or by removing the root from every relying
party's trust store.

That is acceptable for a development root with hour-scale lifetimes. It is not
acceptable once ADR 0066 makes the CA hierarchy real, ADR 0068 lets devices
enroll themselves over SCEP and EST, and ADR 0070 issues code-signing
certificates whose compromise has to be answerable within minutes. Revocation is
the mechanism that turns "we issued this" into "we can take it back", and every
other decision in this series assumes it exists.

Two delivery mechanisms are available and they are not equivalent. A CRL is a
signed list the relying party fetches and caches; it is simple, cacheable, works
offline once fetched, and is always stale by up to its refresh interval. OCSP
(RFC 6960) answers one serial at a time, freshly, at the cost of a live request
per check. The compared vendor ships CRL only. Relying parties in the deployments
this targets — device fleets over SCEP, internal service meshes, code-signing
verifiers — routinely want the fresh answer.

## Decision

### 1. Revocation is a first-class record, not a status flag

Revoking a certificate writes a row to the forthcoming `certificate_revocations`
table (`certificate_id`, `ca_id`, `serial`, `reason_code`, `revoked_at`,
`crl_number`) *and* transitions the inventory row to `revoked` with
`revocation_reason` and `revoked_at` set, in one transaction with the
`certmgr.certificate.revoked` outbox event (ADR 0066 §5). `reason_code` is the
RFC 5280 `CRLReason` integer, not a free-text string, because it is emitted
verbatim into the CRL entry extension and into OCSP responses; an unmappable
reason would have to be silently rewritten at emit time.

`UNIQUE(organization_id, ca_id, serial)` makes revocation idempotent: revoking
twice is a no-op rather than a second CRL entry for the same serial. Revocation
is never undone. `certificateHold` (reason 6) exists in the enum for
completeness but the un-hold path (`removeFromCRL`, reason 8) is not built — a
CA that can un-revoke needs an operator story for the window in which relying
parties saw the hold, and we do not have one worth the complexity.

The route is `POST /api/v1/certmgr/certificates/{id}/revoke` (forthcoming
`apps/gateway/src/routes/certmgr_inventory.rs`), gated on application `operator`
or above.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 2. CRL v2, signed by the issuing CA, with a monotonic CRL number

Each CA has at most one current CRL, held in the forthcoming `crl_state` table
keyed `UNIQUE(organization_id, ca_id)`. Generation builds an RFC 5280 CRL v2
containing every unexpired revoked serial for that CA, with per-entry
`CRLReason` and `invalidityDate` where known, and the `cRLNumber` extension.

`crl_number` is a monotonically increasing integer per CA, stored in
`crl_state` and incremented on every regeneration — never derived from a
timestamp and never reused. Relying parties use `cRLNumber` to reject a
replayed older CRL; a non-monotonic sequence would let an attacker who can
serve a stale-but-validly-signed CRL roll back the revocation set. The CRL is
signed by the issuing CA's own key, through the same custody-agnostic `Signer`
trait as issuance (ADR 0071 §4), so an HSM-held CA signs its CRL in the HSM.

Only the CA that issued a certificate may carry its revocation. There is no
cross-CA CRL and no "organization CRL": a CRL's authority is exactly its
signer's.

Gate: `cargo +1.88.0 test -p opensesame-pki-core`

### 3. Two regeneration triggers, and only two

A CRL is regenerated:

1. **On revoke** — synchronously in the revoke path, so a relying party that
   fetches immediately after an operator revokes sees the new entry. If
   regeneration fails, the revocation still commits (the record and the status
   are the source of truth) and the lifecycle actor retries; a revocation must
   never be lost because a signing step was unavailable.
2. **On approaching `next_update`** — the certificate lifecycle actor
   (forthcoming `apps/gateway/src/cert_lifecycle.rs`, modeled on
   `apps/gateway/src/rotation_scheduler.rs`) regenerates any CRL whose
   `next_update` is inside its horizon, so a CRL never goes stale merely because
   nothing was revoked.

The two producers coordinate **only through the `crl_state` row** — there is no
shared handle, channel, or lock between the revoke route and the actor. Both
read the current `crl_number`, increment, and write under the row's optimistic
`version`; a losing writer re-reads and retries. This is the same coordination
discipline the rotation scheduler already uses, and it is why the revoke path
can be synchronous without the actor and the route racing each other into a
duplicated CRL number.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 4. CDP embedded at issuance; up to four advertised mirrors, advertise-only

Every certificate issued by an internal CA with `crl_enabled` carries a CRL
Distribution Point extension pointing at `GET /crl/{caId}.crl` on the gateway's
configured public base URL. Embedding happens at issuance because a CDP cannot
be added to a certificate afterwards — a certificate minted without one can
never be checked by a CRL-using relying party, no matter what we build later.
Making this the default (rather than opt-in) is deliberate: the failure mode of
an unnecessary CDP is a wasted fetch, and the failure mode of a missing one is
an unrevocable certificate.

A CA may additionally advertise up to **four** mirror URLs
(`crl_mirrors_json`, ordered), which are emitted as additional
`distributionPoint` entries. Four is the cap because the extension is copied
into every certificate the CA issues and unbounded lists inflate every leaf.

Mirrors are **advertise-only**. OpenSesame does not publish to them, does not
poll them, and does not verify that they serve the current CRL. The operator
republishes the DER we serve to wherever those URLs point. The alternative —
having the gateway push to mirror endpoints — would require credentials and
egress to arbitrary operator infrastructure inside the revocation path, which
is the one path that must stay available when everything else is failing. An
operator whose mirror is stale has a stale mirror; OpenSesame's own endpoint
remains authoritative and is always listed first.

Gate: `cargo +1.88.0 test -p opensesame-pki-core`

### 5. An RFC 6960 OCSP responder — the deliberate differentiator

`POST /ocsp/{caId}` (`application/ocsp-request`) and
`GET /ocsp/{caId}/{base64request}` implement an RFC 6960 responder over the same
revocation records (forthcoming `apps/gateway/src/routes/revocation.rs`). The
responder parses the request, looks up each requested serial against
`certificate_revocations` scoped to that CA, and returns a signed
`good` / `revoked` / `unknown` status with `thisUpdate`/`nextUpdate`.

`unknown` is returned for a serial this CA never issued — not `good`. Answering
`good` for an unknown serial would make the responder assert something it cannot
know, and a relying party that trusts `good` from a CA it trusts would accept a
forged serial.

Building this when the compared product does not is a considered cost. It is one
more signing surface and one more unauthenticated endpoint to harden. It buys
the property that matters for device fleets and code signing: a revocation is
answerable *now*, not at the next CRL refresh. It also degrades better — a
relying party that cannot reach the responder can still fall back to the CRL,
because both are populated from the same records.

Gate: `cargo +1.88.0 test -p opensesame-pki-core`

### 6. The responder signs with the CA key or an explicitly delegated OCSP-signing certificate

Two signing modes, and no third:

- **CA-direct.** The response is signed by the issuing CA key. Simplest, and
  correct: the CA is the authority on its own revocations.
- **Delegated.** An operator may configure an OCSP-signing certificate issued by
  that same CA and carrying the `id-kp-OCSPSigning` extended key usage. The
  responder then signs with the delegate and includes it in the response so the
  relying party can validate the delegation chain.

Delegation exists because it lets the CA key stay cold (or stay in an HSM with a
low signing rate) while a hotter, cheaper key answers the query volume. Its
constraints are strict: the delegate must be issued by the CA it answers for,
must carry `OCSPSigning` EKU, and is rejected otherwise at configuration time,
not at response time. Anything else — a delegate from a different CA, an
externally supplied signer, a key without the EKU — is refused. A responder that
would sign for a CA it cannot demonstrate delegation from is an unbounded
revocation-forgery surface.

Gate: `cargo +1.88.0 test -p opensesame-pki-core`

### 7. CRL DER is sealed at rest

The signed CRL is stored in `crl_state` through the standard sealed-blob column
group (`SEALED(sealed_der)`) under its own scope constant `crl_der`, using
`seal_scoped` from `crates/connection-broker/src/crypto.rs` with
organization- and CA-bound AAD.

A CRL's *content* is public — that is the whole point of §8. Sealing it is not
about confidentiality. It is about **integrity and provenance at rest**: the
authenticated encryption binds the blob to its organization, its CA and its
record kind, so a database-level write that swaps one organization's CRL for
another's, or replaces a CRL with an older attacker-supplied one, fails to open
rather than being served. Without sealing, the serving path would have to
re-verify the CRL signature on every request to get the same guarantee, at the
cost of a public-key verification per fetch on a hot, unauthenticated endpoint.
Sealing also gives us a uniform custody story: every secret-or-integrity-bearing
blob in this subsystem goes through one primitive with one AAD discipline, and
`SealedCertificateMaterial`'s redacting `Debug`
(`crates/storage/src/lib.rs`) applies without a special case.

Gate: `cargo +1.88.0 test -p opensesame-storage`

### 8. CRL and OCSP reads are unauthenticated, and that is correct

`GET /crl/{caId}.crl`, `GET /crl/{caId}.pem`, and both OCSP endpoints require no
session, no bearer token, and no organization membership.

This is not a relaxation of the authorization posture; it follows from what the
data is. A CRL is a signed statement whose entire purpose is to be fetched by
relying parties that have no account with us — a device checking a peer, a
browser, a signature verifier. Requiring credentials would make revocation
undeliverable to exactly the parties revocation exists to inform, and any
credential distributed widely enough to work is not a credential.

The information disclosed is the set of serials a CA has revoked plus the
reason codes. That set is already inferable by anyone holding the certificates,
and withholding it fails safe in the wrong direction: an unreachable CRL causes
relying parties to accept revoked certificates. Confidentiality of the
revocation list is worth less than its availability, by a wide margin.

What these endpoints must *not* do is leak anything else. They are strictly
read-only, emit only DER/PEM (or an OCSP response) for the requested CA, take a
CA id as their only path parameter, disclose nothing about which organization
owns that CA, and return the same shape for "no such CA" as for "CA with no
CRL". They carry explicit body limits, and the OCSP `GET` form caps the encoded
request length. They are listed in the contract allowlist
(`apps/gateway/src/routes/contract.rs`) with an unauthenticated-by-design
category comment so the exemption is reviewed rather than assumed.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

## Alternatives considered

- **CRL only** (the compared product's choice). Simpler; one fewer signing
  surface and one fewer unauthenticated endpoint. Rejected because CRL freshness
  is bounded by the refresh interval, and the code-signing and device-enrollment
  paths in this same series need a revocation to take effect on a scale of
  minutes, not hours.
- **OCSP stapling only, no responder.** Stapling is a relying-party-side
  optimization over a responder; without a responder there is nothing to staple.
  Not an alternative, a complement — and one we do not build here because
  OpenSesame is not the TLS terminator for the certificates it issues.
- **Short-lived certificates instead of revocation.** Attractive and genuinely
  used elsewhere, but it forces every consumer onto an automated renewal path.
  SCEP-enrolled devices and code-signing certificates are exactly the consumers
  that cannot be assumed to renew hourly. Short lifetimes remain available via
  profile TTL; they are not a substitute.
- **Publishing to mirrors ourselves.** Rejected in §4: credentials plus egress
  to arbitrary operator infrastructure, inside the path that must stay up when
  the rest is down.

## Consequences

- Every internal-CA certificate grows a CDP extension. Certificates issued
  before this change have none and can only be revoked in a way OCSP-capable
  relying parties see; the CRL still lists them, but a certificate with no CDP
  gives a relying party no way to find that CRL.
- The gateway gains two unauthenticated route families. They are the only
  unauthenticated mutating-free surface in the certmgr namespace and are
  allowlisted explicitly so the exception stays visible in review.
- CRL regeneration is a signing operation on the revoke path, so an HSM-backed
  CA makes revocation depend on HSM availability. §3's fallback (record commits,
  actor retries the CRL) keeps that from turning an HSM outage into a lost
  revocation.
- `crl_number` monotonicity is now a correctness invariant with a database
  representation. Restoring an old database backup can move it backwards; the
  operator runbook must treat CRL state as forward-only, and the validation doc
  records this as a residual risk.
