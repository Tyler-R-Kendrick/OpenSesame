# Identity evidence for Host authorization — 2026-09-08

Identity now exposes an explicit, default-disabled Host authorization ceremony.
`OPENSESAME_HOST_AUTHORIZATION_AUDIENCES` names exact accepted Host resources;
enabling it requires configured persistent `OPENSESAME_JWKS_JSON` material.
Assertions use the one eligible RS256 signing key (RSA modulus at least 2048
bits) from the existing OIDC configuration and public JWKS, not AgentAuth's
ephemeral signing runtime. No key is fetched from a request or assertion.

The options route freezes Host challenge ID/digest, exact audience, organization,
operation, target, transition, origin, DPoP thumbprint and expiry. The real
WebAuthn challenge commits to that full tuple and the authenticated principal.
The pending state and challenge survive another application instance over the
same database; the pending transaction is atomically spent before verification.
Invalid signatures require a new ceremony. Capacity is bounded and stale state
expires. Membership is checked both before the ceremony and after verification.

The verifier always uses SimpleWebAuthn, even when other local development
fixtures use a permissive passkey seam. UP/UV, signature, RPID, origin, challenge,
principal ownership and counter advancement are checked. An ordinary session
or operator credential cannot substitute for this verification. Successful
assertions contain server-derived principal, current role, authentication time
and WebAuthn AMR, use `typ: host-authorization+jwt`, and expire within five
minutes and before the underlying Host challenge.

## Evidence and composition requirements

Focused tests generate real P-256 credentials, COSE public keys and signed
WebAuthn assertions. Missing UV is refused; valid evidence produces a
cryptographically verified RS256 assertion; concurrent redemption has one
winner. A second PGlite-backed application instance verifies the same pending
ceremony while racing the first. Tests also reject client-supplied assurance,
wrong transaction, unknown audience, bad origin, expired challenge, invalid
transition and membership removal.

Validation: the complete Identity suite passed 79 files / 932 tests in 27.66
seconds before the secret-free issuance audit addition; the focused real-crypto
suite was rerun afterward. Auth-upstream's 13 files / 89 tests and Identity's
TypeScript check passed. The focused test uses real signatures, not a mocked
verification success. No live endpoint or external scanner was used.

The Host consumer must independently pin issuer/JWKS/audience/type, compare
every signed display field with its pending challenge, enforce its hidden
version/transition digest, and atomically consume its pending state. Identity's
signature is not an operator credential or permission to bypass Host policy.
The first-party ceremony must display the frozen challenge before prompting
the authenticator. Those Host/client integration checks belong to the final
integrated evidence, not this producer-only audit. Same-origin malicious script
can request ceremonies; user verification is not a claim to eliminate XSS.

Key rotation must retain validation for unexpired assertions. Multiple eligible
private signing keys are refused rather than chosen ambiguously. Disable the
audience configuration to stop new assertions without affecting ordinary
Identity, offline Pages or guest access.
