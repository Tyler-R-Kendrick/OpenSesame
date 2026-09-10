# Browser-local sign-in deadlines

Date: 2026-09-10

## Finding and correction

Repeated real-browser IAM journeys captured `clock_reversed` from the relying
party SDK before passkey verification. The SDK compared the current wall clock
with the wall clock recorded when opening the popup. A backward clock correction
therefore cancelled an otherwise live consent transaction.

Consent now has a five-minute monotonic deadline using `performance.now()`.
After redemption, the client captures wall and monotonic time together and
limits the session to the remaining validated credential lifetime. It closes
on either the monotonic deadline or absolute credential expiry: moving the wall
clock backward cannot extend the session, and moving it forward still expires
the credential. Issuer-side timestamp, membership, policy, revocation and grant
checks are unchanged and remain fail-closed.

The SDK exposes stable failure codes, never issuer error bodies. The browser
verifier records only allowlisted failure stages and numeric clock correction;
failure screenshots use disposable fixture identities and stay under `/tmp`.

## Regression evidence and limits

The static-auth suite passes 61 tests, including backward clock correction
during consent, bounded consent expiry, active-session expiry with corrections
in both directions, popup closure, request timeout and refusal-body redaction.
The existing forged-identity, exact-source/origin and scope tests remain intact.

Further stress runs observed live-session/revocation refusals and measured
backward wall-clock offsets of 2,926 and 5,828 milliseconds. These observations
do not individually attribute every earlier failure. The happy-path browser
fixture now uses Playwright's advancing context clock. A separate, explicit
rollback in the same journey proves that authenticated session use is refused
by the real issuer. Both 1280px and 390px journeys pass, including actual
WebAuthn verification, PKCE exchange, scope checks, revocation and denial.
The virtual authenticator's incremented counter is preserved between popups;
replay checks were not bypassed to make repeat sign-in pass.

Final repetition: three consecutive runs passed both viewport journeys (six
journeys total), each including explicit rollback refusal. Static-auth
typecheck, scoped strict anti-slop, `pnpm quality`, and `git diff --check` pass.

No security check was relaxed to make the browser journey pass. These are
controlled-clock browser results, not a claim of repeated success with an
unstable host clock. Full browser IAM completion, a clean full verification
run, and release readiness are not claimed here.
