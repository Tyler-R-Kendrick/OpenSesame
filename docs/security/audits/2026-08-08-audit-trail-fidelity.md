# Audit tick 64 — a trail that can show an attack

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `packages/audit`, the audit
repositories in `packages/database`, and the events the control plane actually
writes.

## Refusals were not recorded (fixed)

Every audit event in the control plane was `outcome: "succeeded"` bar one. That is
the single shape of trail that cannot show an attack: five wrong TOTP codes
followed by one right one read as one ordinary login, and guesses against a
claim's ~40-bit user code left nothing behind at all — even though both paths
already count failures to close a fence.

Denials are now written where the fences are:

- `mfa.totp.verify` — `bad_code` and `too_many_attempts`
- `mfa.passkey.assert` — `assertion_failed` and `too_many_attempts`, with the
  credential id as the target
- `claim.complete` — `invalid_user_code` and `too_many_attempts`, against the
  claim id

## The metadata allowlist dropped what the call sites recorded (fixed)

`redactAuditMetadata` keeps allowlisted keys only, and the allowlist did not
contain `kind`, `issuer`, `tenant`, `slug`, `note`, `sectorIdentifier`,
`admissionMode`, or `previousClientId` — all of which call sites pass. So
`principal.link_identity`, the event that carries an assurance upgrade, recorded
`action` and nothing about which issuer or subject kind granted it. Those keys are
now allowlisted.

Some of them are request-shaped (an issuer URL, a sector identifier), so string
values are bounded at `AUDIT_VALUE_MAX_LENGTH` (256) and truncated rather than
dropped: a shortened issuer still tells a reviewer what happened, and the store
no longer grows to whatever length a caller sends.

## Read and left alone

- The deny-key regex already strips token, secret, code-verifier, user-code and
  device-code shaped keys before the allowlist is consulted, and non-scalar values
  are dropped.
- `auditEvents.list` filters by principal in both the memory and Postgres
  repositories, so the endpoint is not a window onto another principal's trail.
- The Postgres repositories are Drizzle query builders throughout — no string-built
  SQL — and their compare-and-swap updates gate on the expected version.

## Not addressed

Control-plane audit events carry no integrity chain: no previous-event digest and
no signature, unlike `InvocationReceipt` on the Rust side. Tamper evidence for
this trail is a design change (hash chaining plus a signer), not an audit patch.
