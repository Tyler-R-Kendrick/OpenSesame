# ADR 0146 — Removing an account factor takes a step-up

- Status: Accepted
- Date: 2026-09-26
- Amends: [ADR 0140](0140-pages-hosts-every-ceremony.md) D10 (the account's
  factors are rows in Settings › Security)
- Builds on: [ADR 0091](0091-account-exits-and-unlock-ceremony.md) (one
  read-only Security list, one sheet), [ADR 0084](0084-external-authorization-notifications.md)
  (a WebAuthn activation bound to its transaction and spent once)

## Context

`DELETE /v1/mfa/factors/:id` removed one of the signed-in principal's account
passkeys, or its authenticator seed, on the strength of the session alone. A
stolen or hijacked session could therefore strip a person's second steps —
the one thing that was meant to hold after a session leaks. NIST SP 800-63B
§6.1.2.1 asks that removing an authenticator be authenticated at the
account's own assurance level.

Two shapes were possible for the passkey half:

1. **Inline verification.** The delete carries a WebAuthn assertion over a
   challenge the service issued to this principal for this one removal, and
   the service verifies it on that request.
2. **A step-up grant.** `/v1/mfa/passkey/assert` mints a short-lived,
   single-use, principal- and purpose-bound grant, and the delete spends it by
   compare-and-set.

## Decision

**The delete carries a fresh proof from one of the principal's own enrolled
factors, verified inline on the delete itself.** The factor being removed
counts, so the last factor can still be removed by proving it.

- `DELETE /v1/mfa/factors/:id` takes `{ "proof": … }`:
  - `{ "kind": "totp", "code" }` — the account authenticator's current code,
    spent on a per-principal step ledger (below);
  - `{ "kind": "passkey", credentialId, clientDataJSON, authenticatorData,
    signature }` — an assertion over a removal challenge.
- `POST /v1/mfa/passkey/authentication-options` with
  `{ "purpose": "factor.remove", "factorId" }` issues the removal challenge: a
  `transaction`-purpose WebAuthn challenge bound to the principal, with
  `transactionDigest = sha256({purpose, principalId, factorId})` and a
  five-minute life. It answers 404 for a factor the caller does not hold.
  Without a body the route issues the plain sign-in challenge as before.
- The delete reads what the challenge was minted for *before* the verifier
  spends it, and refuses anything but a `transaction` challenge for this
  principal whose digest matches this removal. It then verifies through
  `hostAuthorizationPasskeys` — the real SimpleWebAuthn verifier, never the
  development stub — which consumes the challenge (single use) and checks the
  signature, counter and that the credential is the principal's.
- **Why inline.** It needs no new store and no new credential: the only thing
  minted between the two requests is a WebAuthn challenge, which is already
  single-use, short-lived and principal-bound, and which cannot be spent as a
  sign-in (`/passkey/assert` expects `authentication`), as a Host
  authorization or as an interaction approval (their digests differ). A grant
  would be a second bearer-like artefact with its own lifetime, replay and
  audit surface, and binding it to the factor id would need the same digest
  anyway. Inline verification also puts the proof, the check and the removal
  in one request and one audit row.
- **TOTP replay.** A code is accepted once per principal per 30-second step
  (RFC 6238 §5.2). The step ledger (`totpSteps`, durable where a database is
  configured) moves forward by compare-and-set and is shared by
  `/v1/mfa/totp/verify`, interaction TOTP activation and removal, so a code
  seen anywhere proves nothing a second time. A code is accepted wherever a
  seed is stored, as interaction activation already does; enrolment remains
  development-only.
- **Failure fences** are the existing ones: `totp:<principal>` and
  `passkey:<credential digest>` in `mfaFailures`, five failures, shared with
  `/totp/verify` and `/passkey/assert`.
- **Refusals are 403, never 401.** No proof is `403 step_up_required`; a proof
  that does not verify (wrong, expired or replayed code; a challenge for
  another principal, purpose or factor; a replayed or forged assertion) is
  `403 step_up_failed`; a fence is `429 too_many_attempts`. Pages'
  `identityFetch` ends the session on a 401, and a person asked to prove it is
  them has not been signed out. A malformed proof is `400 invalid_request`.
- **Audit.** `mfa.factor.remove` records `mechanism` (`totp` or `passkey`,
  the factor kind that proved it). Every refusal writes a `denied`
  `mfa.factor.remove` event with its `reason` (`step_up_required`,
  `bad_code`, `code_replayed`, `not_enrolled`, `challenge_mismatch`,
  `assertion_failed`, `too_many_attempts`) and `mechanism`, targeted at the
  factor id — never a credential id, code or assertion.

**Pages.** The removal card in the one Security sheet asks for the proof
before it sends the delete. Where the account holds both kinds the person
picks which to prove with, as a choice object; the act is the one danger key.
The Security list stays read-only — one row per factor, one action, no input
(ADR 0091). Both outcomes are a `StatusMark` in the card's live region: a
refused proof keeps the sheet open, clears the code and puts the keyboard
back on the field (or the key); a removal lands on Done. An authenticator
setup closed before its code matched is still removed: its seed is in the
sheet's memory, so it proves its own removal with the code it computes then.

The registry keeps `identity.account_factors.remove` as one operation; MCP and
WebMCP stay excluded as an authentication ceremony.

## Consequences

- A stolen session no longer strips a factor; it needs one of the factors.
- An account whose only factor is a passkey, in a browser that cannot make
  WebAuthn assertions, cannot remove it from that browser; the card says so
  and sends nothing.
- An abandoned authenticator setup whose code the device computes on a clock
  more than a step away from the service's is not removed on close; it stays
  a factor its owner can remove with any other proof.
- `/v1/mfa/totp/verify` now refuses a code it has already accepted within its
  step, which it should always have done.
