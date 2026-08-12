# Audit tick 37 — passkey signature counter, device approval fence

Scanners (osv-scanner, gitleaks, cargo-deny, clippy, semgrep, cve-lite,
task-security-battle-test) were clean on `main` (9abebc9). Both findings came
from reading the MFA and device-authorization paths.

## 1. Passkey signature counter never advanced (clone detection dead)

`createSimpleWebAuthnVerifyFn` discarded `authenticationInfo.newCounter` and
`createPasskeySeam.verify` only looked at a boolean, so the stored
`credential.counter` stayed at its registration value for the life of the
credential. SimpleWebAuthn's counter check therefore compared every assertion
against a frozen baseline: a cloned authenticator (or one extracted from a
device) could keep asserting indefinitely without the regression ever being
noticed. Challenge single-use already blocked straight replay, but WebAuthn L2
§7.2 step 21 exists precisely to surface cloning, and it was inert.

Fix:

- `PasskeyVerifyFn` may now resolve to `{ ok, newCounter }` (plain `boolean`
  still accepted for dev/test injection).
- `createPasskeySeam.verify` refuses an assertion whose non-zero counter fails
  to exceed the stored value and persists the advanced counter otherwise.
- Authenticators that report `0` (no counter support) keep working.

`packages/auth-upstream/src/__tests__/passkey.test.ts` covers advance, stall,
regression, counter-less authenticators, and the boolean verifier.

## 2. A wrong `user_code` guess cancelled every pending device login

`POST /api/v1/device/approve` counted each miss against **all** live
`DevicePending` entries and pruned any entry at the cap, so five wrong guesses
destroyed every in-flight device authorization on the instance — a trivial
denial of service against device login, available to anyone who can reach the
approve proxy.

A guess cannot be attributed to a specific pending authorization, so the fence
has to be global; it is now a cooldown instead of an invalidation:

- `MAX_APPROVE_FAILURES` (10) failures inside a 60 s sliding window answer
  `429 too_many_attempts` with `retry_after_seconds`.
- Misses cost the guesser budget only; pending authorizations are pruned solely
  by `expires_at`.
- `approve_attempts` was removed from `DevicePending`.

With ~34.6 bits of user-code entropy (8 chars over a 20-symbol alphabet) and
10 guesses/minute, a 15-minute authorization window admits ~150 attempts —
brute force remains infeasible while legitimate approvals survive an attack.

Unit tests in `apps/gateway/src/routes/device.rs` assert that repeated failures
leave the pending set intact and that the failure window prunes and caps.
