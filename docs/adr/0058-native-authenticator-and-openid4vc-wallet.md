# ADR 0058: Native authenticator and OpenID4VC wallet

Status: Accepted

## Context

OpenSesame must act as a native holder/wallet for OID4VP and OID4VCI. Password,
OTP, and passkey provider work is not part of this decision.

These surfaces combine cryptographic custody, platform entitlements, remote
request processing, and consent. Handwritten protocol or WebAuthn crypto would
create a second security-critical implementation beside the platform APIs.

## Decision

1. OID4VP 1.0, OID4VCI 1.0, HAIP 1.0, SD-JWT VC, mdoc, and Digital Credentials
   handling use the pinned Multipaz native SDK. OpenSesame owns vault mapping,
   issuer/verifier policy, consent, and audit receipts; it does not fork those
   protocols.
2. Browser-to-app handoff uses associated HTTPS links or the standard
   `openid4vp`, `openid-credential-offer`, `haip-vp`, and `haip-vci` schemes.
   Vendor HTTPS links carry an HTTPS `request_uri`; opaque request ids are
   accepted only for OpenSesame MFA, where a resolver already exists. Tokens,
   authorization codes, inline offers, and credentials are refused.
3. Host sync is opaque ciphertext with owner scoping and atomic compare-and-set
   revisions. A conflict is pulled, authenticated and decrypted on the device,
   merged deterministically, resealed, and retried as a newer revision.
4. OID4VP/OID4VCI deployment flags remain off until the signed build for that
   deployment passes the applicable OpenID Foundation conformance profiles.
   Flags are rollout gates, not statements that the product omits the feature.

## Consequences

Native wallet builds require store signing identities, associated-domain files,
Apple entitlements, Android signing fingerprints, issuer/verifier trust
configuration, and physical-device verification. Repository tests establish
parsing, custody, sync, and policy invariants but cannot substitute for those
external checks or for OpenID certification.
