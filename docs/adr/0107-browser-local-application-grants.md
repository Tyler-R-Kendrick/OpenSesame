# ADR 0107: Browser-local application grants

Status: Accepted for the local authorization boundary and browser-mediated
application sign-in. This is not a network OIDC provider.

## Decision

Reuse the local passkey session and application admission boundary from ADRs
0104–0106. An application request binds the exact registered client, redirect
URI, requested scopes, state, nonce and S256 PKCE challenge. Approval must follow
a human review of that exact request; registering an application is not consent.

Authorization codes contain 32 random bytes. Only their SHA-256 digests index
the issuer tab's pending map. Pending codes expire within two minutes and never
outlive the source session. The map permits at most 128 pending requests;
expired entries are reclaimed before admitting another. Locking or reloading
the issuer cancels pending requests. No code or verifier is persisted.

Redemption revalidates the current session, organization membership and
application revision inside the existing directory fence. The client, callback
and S256 verifier must match. One winner removes the code before writing a
grant. A failed write burns the code; it cannot return authority or be retried
as if persistence succeeded.

The encrypted `config/identity-grants` ledger contains at most 512 validated
records and one megabyte of plaintext. It contains bindings and expiry, never
the authorization code or PKCE verifier. Invalid records fail closed without
resetting the ledger. The returned grant is an issuer-local object capability;
copying or serializing its public handle loses authority.

Every protected operation requires the original capability, its exact
application and a subset of its granted scopes. It rechecks the source session,
current membership, application revision, expiry and revocation under the
same fence. After asynchronous policy reads it checks session liveness again,
so a vault lock during those reads cannot admit the protected action. Revocation
and grant use are serialized. Owners may list and revoke their own ledger
records; listing a record does not prove it is still usable.

## Limits

The `/identity/authorize` screen unlocks the existing vault, verifies a chosen
local person's passkey, and asks for explicit application consent. The SDK opens
a fresh popup, validates its exact origin and window identity, and transfers a
single MessagePort only after that popup announces readiness with the expected
transaction state. The issuer accepts only its exact opener and registered
callback origin. State, nonce and PKCE are pinned by the initiating RP.

The channel retains the grant inside the issuer. Its bounded, sequential RPCs
allow redemption, identity checks and revocation, not arbitrary methods or
resource access. Identity responses use a public local subject identifier and
the exact client audience; they contain no upstream token or vault data. Closing
the issuer, locking its vault, navigating away or reaching expiry ends access.
The SDK never persists a bearer, verifier or private key.

These are not public HTTP OAuth endpoints, signed ID tokens, or a completed
OIDC provider. Resource-specific authorization and agent authentication remain
necessary for full browser IAM.

The authorization popup must retain its cross-origin opener. Development uses
`Cross-Origin-Opener-Policy: unsafe-none` on this exact route only; other routes
retain `same-origin`. Production deployments must configure the same scoped
exception. This popup is not cross-origin-isolated. The exception does not admit
browser-to-Host operator authority, and exact message origin/source checks remain
mandatory. Same-origin paths still do not create separate trust domains.

The vault custodian remains the local administrative trust root. An unlocked
same-origin script can act as that custodian; these controls are not an XSS
boundary. Losing the issuer tab or its in-memory session requires a new sign-in.
Browser storage and backup guarantees remain those of the existing VFS.

## Verification

`local-authorization.test.ts` uses real WebAuthn verification and encrypted VFS
records. It checks PKCE/client/callback binding, concurrent redemption, scope
widening, copied handles, session and application revocation, expiry, clock
rollback, capacity reclamation, corrupt storage, failed persistence, and a vault
lock deliberately triggered during asynchronous policy loading.
