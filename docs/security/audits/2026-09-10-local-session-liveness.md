# Local IAM session liveness across asynchronous policy reads

## Finding and correction

A vault lock clears the local session's in-memory presentation immediately,
independently of the directory's asynchronous storage fence. Validating a
session only before reading application or organization policy would allow a
lock during that read to leave the callback using an obsolete admission.

The shared `withLocalIdentitySession` boundary now supplies a liveness check
to its callback. Application admission, grant use and organization operations
call it after their asynchronous policy reads and before returning protected
data or performing their action. It verifies the original presentation,
origin and session lifetime. Callbacks must not reacquire the same fence.

Grant redemption also rechecks after persistence and never returns a grant
if locking invalidated its in-memory presentation. A failed persistence attempt
burns the authorization code rather than permitting ambiguous replay.

## Regression evidence

`local-authorization.test.ts` enrolls and signs in with a real verified test
passkey, redeems a PKCE-bound code, then locks the vault while opening the
organization policy record. It proves that this lock actually occurred,
requires the session-unavailable refusal, and asserts the protected callback
was never called. An unrelated parsing error cannot satisfy that test.

Focused tests also exercise concurrent redemption, stale application
registration, session and application revocation, code expiry/clock rollback,
bounded pending requests, corrupt grant storage and write failure.

## Scope

This is source review and local regression evidence, not a Codex Security,
DeepSec or Mantis scan. The local grant functions are not yet a public browser
transport or complete OIDC issuer. Same-origin script compromise and the
unlocked vault custodian remain outside this session-isolation guarantee.
