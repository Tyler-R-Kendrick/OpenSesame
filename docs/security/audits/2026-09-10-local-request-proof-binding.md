# Local request proof binding — 2026-09-10

Scope: the browser-local passkey verifier in the uncommitted Pages worktree.

Local sign-in evidence previously established a person, origin and credential,
but did not commit to an authorization request. That evidence must not be
mistaken for transaction approval when the local request inbox is introduced.

The shared verifier now accepts an optional SHA-256 base64url request digest.
For a request proof, WebAuthn signs a domain-separated commitment to that digest
and a fresh 256-bit nonce. Its caller must derive the digest from the frozen
request, decision, target and effective policy; arbitrary display text is not
an authorization digest. Ordinary sign-in retains its existing ceremony.

Evidence is a frozen, private, single-use object. Consumption requires the same
digest, origin, unlocked vault and unexpired wall/monotonic deadlines. A mismatch
burns the proof. Copying evidence or presenting a request proof as ordinary
sign-in fails. Lock clears outstanding evidence, including a ceremony whose
verification completes after the lock. Credential verification, user
verification, counters and encrypted write-before-success remain shared.

Real cryptographic fixture tests cover the exact challenge commitment, different
request/decision refusal, assertion replay, object copying, single use, malformed
digests, lock/reopen and monotonic expiry. Existing sign-in/session tests remain
applicable. No ignored diagnostic, weakened verifier or fake passkey success was
added.

This is an implemented proof primitive, not a completed request inbox. The
existing Requests screen still uses remote Identity; durable local request
creation, atomic decision/consumption and UI integration are not established by
this change. It does not make a static PWA a remotely reachable OIDC server.

During the complete Pages rerun, a pending GitHub registration fallback updated
React after its panel unmounted. Registration now owns and cancels that timeout,
and refuses navigation or notifications from an obsolete asynchronous result.
Regression tests cover pending response completion after unmount, timeout
cancellation and the still-mounted error path. This repair does not alter IAM
authority or suppress the suite's unhandled-error gate.

Verification after these changes:

- `pnpm --filter @opensesame/pages test`: 3575 tests in 293 files pass, 117.06s.
- Focused passkey/session verification: 36 tests pass; connector lifecycle and
  existing Connections coverage: 60 tests pass.
- Pages production build/typecheck passes. All eight real Chromium IAM journeys
  pass at 1280px and 390px. These journeys exercise existing sign-in and grant
  paths, not an inbox that has not yet been implemented.
- Scoped strict anti-slop, Biome, design lint (292 files), structural quality
  (no regression), and `git diff --check` pass.
- No full root verification, bundle-budget clearance, external model scan,
  commit, pull request, merge or deployment is claimed.
