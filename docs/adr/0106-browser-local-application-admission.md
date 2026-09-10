# ADR 0106: Browser-local application admission

Status: Accepted for encrypted registration and admission checks. Authorization
codes, grants and relying-party transport remain incomplete.

## Decision

A directory application is not a client registration or an access grant.
The vault custodian registers its owning organization, exact callback URIs and
allowed scopes in one encrypted, versioned `config/identity-applications`
record. Registration requires an enabled application and organization with an
assigned human owner. Native Applications controls save, reload and explicitly
remove this registration without requiring an Identity service.

Reuse the static-auth exact-origin validator. Callback URIs must already be
canonical, use HTTPS or loopback HTTP, and contain no userinfo, wildcard or
fragment. Query strings are permitted but compared exactly; paths and ports
are not ignored. Up to sixteen callbacks and thirty-two distinct scope names
are accepted, including `openid`. Registration neither validates control of
an external domain nor grants a person access to it.

Configuration edits use the existing cross-tab directory fence and optimistic
revision check. Writes are capped at 1,000 registrations and 512 KB of plaintext.
Malformed encrypted configuration fails closed, never becoming an empty list.
Removal and re-registration advance the revision, so an old configuration
snapshot cannot represent a newly admitted client.

Admission inspection requires an authentic local session, a current enabled
application and organization, exact registered redirect, allowed requested
scopes and current organization membership. Unknown applications and unrelated
membership produce the same refusal. Registration reads are custodian actions;
the session-facing inspection does not inherit that authority.

## Boundary

The returned inspection is display/configuration data, not a credential. It
must not be accepted as a grant or trusted at a later token exchange. The
authorization and redemption operations must revalidate registration and
membership inside the session fence and bind their own single-use state.

This does not turn a static origin into a network OIDC server. Browser-mediated
relying-party transport, consent, PKCE-bound codes, resource policy and agent
credentials remain required for the full browser IAM objective. Existing
upstream-token passthrough restrictions are unchanged.

The unlocked vault custodian remains the administrative trust root. Same-origin
malicious scripts can use the unlocked vault; encrypted storage is not an XSS
boundary. Browser storage availability and vault backup rules remain those of
the existing VFS, not a new synchronization or durability guarantee.

## Verification

`local-applications.test.ts` uses real WebAuthn-backed sessions and checks
forged handles, unrelated members, disabled clients, callback substitution,
scope widening, malformed input, concurrent edits and failed persistence.
`local-application-contract.mjs` drives the native form with keyboard input,
including rejected callbacks, retained drafts, reopen and confirmed removal.
