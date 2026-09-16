# ADR 0116 — Browser-native Self-Issued OpenID Provider v2

Status: Accepted
Date: 2026-09-15
References: ADR 0090 (static frontend), ADR 0103–0112 (browser-local IAM),
ADR 0007/0008 (hosted identity / oidc-provider), ADR 0086 (wallet/OpenID4VP),
ADR 0117 (hosted SIOP→OIDC bridge),
[`@opensesame/siop-v2` SUPPORT_MATRIX](../../packages/siop-v2/src/index.ts)

## Context

OpenSesame's Pages PWA already issues browser-local application grants without
a Host or Identity API (ADR 0107–0112). Operators also need a standards-shaped
way for a relying party to accept a **self-issued** authentication assertion
whose private key never leaves the vault.

Self-Issued OpenID Provider v2 (SIOPv2) is the OpenID profile for that shape.
It is currently an **Implementer's Draft**, not a Final Specification. The
draft's same-device path returns a Self-Issued ID Token (an OIDC implicit-style
`id_token` response). Modern browser OAuth BCPs prefer Authorization Code +
PKCE for bearer access; this ADR does **not** paper over that tension by
rewriting SIOP into a different protocol. SIOP is scoped to authentication
assertions. Access authorization stays on local IAM (code + PKCE) and hosted
OIDC (code + PKCE, PAR, DPoP).

## Decision

### 1. Three trust profiles stay separate

| Profile | Issuer | Private key | Downstream trust |
| --- | --- | --- | --- |
| Native SIOPv2 | Browser vault (Self-Issued OP) | Never leaves browser | RP verifies `sub_jwk` / JWK-thumbprint `sub` |
| Hosted OIDC | `apps/control-plane` + `@opensesame/oauth-provider` | Hosted OP signing key | Conventional OIDC client trust |
| Experimental browser-signed OIDC facade | Not shipped | — | See §5 |

A hosted token minted after a successful SIOP login is still a **hosted** token.
Compromise of the hosted OP signing key can impersonate subjects to its clients.
SIOPv2 authentication evidence does not make the hosted OP non-custodial.

### 2. Protocol package

`@opensesame/siop-v2` owns parsing, thumbprints, mint/verify, metadata, and the
support matrix. It has no React and no vault I/O. Pages and control-plane call
it. OpenID4VP remains the home for verifiable presentations.

Pinned draft: Implementer's Draft 1 / `openid-connect-self-issued-v2-1_0-07`
(2022-01-28).

### 3. Key model

- Algorithm: ES256 / P-256 only.
- Subject syntax: `urn:ietf:params:oauth:jwk-thumbprint` only.
- Pairwise key per local subject + registered application binding.
- Private JWK material lives only in the encrypted vault VFS.
- WebAuthn/passkeys authenticate the human and gate consent; they are **not**
  the JOSE signing key.

### 4. Ceremony

Route `/identity/siop` reuses local application admission, exact redirects,
passkey sign-in, and consent. Dynamic issuer profile uses an HTTPS issuer on the
Pages origin (loopback HTTP on localhost, 127.0.0.1, or [::1] is allowed for
local dogfood only). `STATIC_SIOP_METADATA` exports the draft static Self-Issued
OP document shape (`authorization_endpoint: "openid:"`, ES256, JWK-thumbprint)
for RP interoperability notes; that custom scheme is **not** a working PWA
invocation mode (SUPPORT_MATRIX). There is no Self-Issued OP discovery HTTP
client in `@opensesame/siop-v2`.

Minted Self-Issued ID Tokens carry the cryptographic `sub` / `sub_jwk` binding
and draft-required issuer markers only. Optional self-asserted profile claims
(email, name, etc.) are **not** minted by this profile. Email auto-link is
forbidden (ADR 0117).

### 5. Experimental browser-signed conventional OIDC facade — not implemented

Delegating hosted `/token` signing to an online PWA over Vercel WebSockets would
require durable cross-instance rendezvous. A process-local socket map is not
that. Until a durable design passes the brief's correctness bar, this facade
stays unimplemented and disabled. Native SIOP and hosted OIDC remain the
supported profiles.

### 6. Deployment

- GitHub Pages: static PWA; native SIOP works without a backend.
- Vercel: optional hardened headers/custom domain for the same static shell;
  hosted Identity stays on the Identity plane. No Cloudflare.

## Consequences

- RPs that want self-issued auth validate SIOP tokens from `sub_jwk`.
- Conventional OIDC clients continue to use `@opensesame/oauth-provider`.
- Docs and UX must label SIOPv2 as Implementer's Draft and must not claim
  hosted compatibility is self-custodial.
