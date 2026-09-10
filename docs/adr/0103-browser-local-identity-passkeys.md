# ADR 0103: Browser-local identity passkeys

Status: Accepted for local credential enrollment and verification, not full IAM completion.

## Decision

Extend ADR 0102's vault-local directory with real WebAuthn credentials. The
unlocked vault custodian enrolls a passkey for an enabled person. Authentication
uses that person's stored public key, exact runtime origin and RP ID, a fresh
32-byte challenge, and mandatory user verification. Reuse the installed
SimpleWebAuthn verifier through an isolated `auth-upstream/browser` export;
never import Better Auth or Node session adapters into Pages. Load the verifier
only when a person invokes a ceremony.

Credential records remain sealed under the existing vault key. Directory edits,
credential writes, counter advancement and revocation share the same Web Lock.
After the authenticator returns, re-read the identity and credential under that
lock. Disabled, deleted, revoked, locked or expired ceremonies fail. Challenge
closures last at most two minutes and cannot be redeemed after a page restart.

The authentication result is local evidence, not a transferable bearer, an
application grant, or an OIDC token. It does not assert hardware key storage:
synced passkeys can satisfy user verification. Agent tools cannot enroll or
revoke human credentials; WebMCP can navigate to the human ceremony only.

## Remaining full-IAM requirements

Organizations and membership policy, agent proof keys, application admission,
audience-bound sessions, authorization grants, session revocation and browser
relying-party transport still need integrated enforcement. Credential management
does not discharge these requirements. Network OIDC endpoints are not supplied
by this local proof API.

The vault custodian remains the local administrative trust root. Same-origin
script compromise can act inside an unlocked vault; this design does not claim
XSS isolation. OPFS-unavailable browsers retain explicitly session-only state,
not durable multi-replica authority. VFS index maintenance is not a multi-file
transaction and must not be used as the commit oracle for external effects.
