# ADR 0112: Request-bound browser application consent

Status: accepted

Extends ADR 0111. The existing browser-local application popup now creates an
encrypted request, obtains a fresh request-bound passkey decision, consumes it
once, and issues through the existing PKCE authorization-code path. It does not
introduce a remotely reachable issuer or export a private session presentation.

An optional authorization digest binds the canonical complete transaction:
application, exact callback, scopes, state, nonce, S256 challenge, and agent/key
when present. Response substitution burns approval without producing a code.
Unbound manual requests cannot be exchanged for application authorization.

An enabled member may consent to their own bound application sign-in subject to
current application scope policy. Ordinary request administration and approval
for an agent still require an enabled human owner/admin. UI role eligibility and
the authoritative decision use the same predicate; the latter also verifies
person, membership, application policy and cryptographic proof.

Consumption persists before issuance. Issuance reacquires the existing session
fence and checks both private sessions, registration revision, the exact consumed
record, expiry, and the original approving key. Revocation between the two fences
therefore refuses issuance. Interruption burns the request; no uncertain retry is
offered. Session authentication and transaction approval are distinct passkey
ceremonies, even when they use the same authenticator.

Existing unbound request digests retain their original bytes. New bound records
contain an optional schema field; older strict-schema clients must be upgraded
before opening a vault containing them. No record is silently discarded.

This connects popup-originated requests, not arbitrary deferred work. Recording
an administrative approval alone still executes no application operation.

## Issuance enforcement clarification

Every person or agent application code requires a consumed, transaction-bound
approval, including lower-level issuance callers. The final fence persists a
one-use issuance timestamp before returning the code. Its failure cannot reopen
an already recorded claim. Request history is retained; refreshed references
do not confer a second issuance. Older strict readers refuse records with the
new issuance marker instead of ignoring its authority constraint.
