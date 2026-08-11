# Audit tick 59 — passkeys that verify their user

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was of the WebAuthn seam in
`packages/auth-upstream`, which the control plane calls the production MFA factor.

## A passkey that never verified its user (fixed)

Both ceremonies were built with user verification optional: the generated options
asked for `userVerification: "preferred"`, and both
`verifyRegistrationAttestation` and `createSimpleWebAuthnVerifyFn` passed
`requireUserVerification: false`.

`preferred` is a request an authenticator may decline. An assertion that declined
it proves the caller holds the authenticator and nothing else — no PIN, no
biometric. `apps/control-plane/src/routes/mfa.ts` turns TOTP away in production and
points callers at `/v1/mfa/passkey/*` as the real factor, so this was one factor
answering for two.

Both ceremonies now demand user verification: `userVerification: "required"` in the
authentication options and in `authenticatorSelection` at registration, and
`requireUserVerification: true` on both verifications. Registration is included on
purpose — enrolling an authenticator that cannot verify its user would mint a
credential that can never satisfy an assertion.

## One principal evicting another's ceremony (fixed)

`createMemoryChallengeStore` caps itself at `MAX_OUTSTANDING_CHALLENGES` and, when
full, dropped whatever was oldest globally. Issuing is one authenticated request,
so a principal asking for challenges in bulk could push every other principal's
outstanding challenge out of the store and fail their logins mid-ceremony.

Eviction now prefers the issuing principal's own oldest challenge, falling back to
the global oldest only when the issuer holds no slot. Flooding still costs the
flooder its own challenges; it no longer costs anyone else theirs.

## Read and left alone

- The signature counter is persisted and non-advancing counters are refused
  (`packages/auth-upstream/src/passkey.ts`) — clone detection is live.
- Challenges are consumed before verification, so a failed ceremony burns its
  challenge rather than leaving it for a retry.
- Authentication challenges are only issued under an authenticated session, and an
  assertion is matched against the challenge's bound principal.
