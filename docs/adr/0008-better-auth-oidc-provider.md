# ADR 0008: Better Auth upstream + oidc-provider downstream

## Status
Accepted

## Decision
- **Upstream** human auth: Better Auth (passkeys, anonymous/provisional sessions, OIDC/OAuth providers).
- **Downstream** issuer: panva `oidc-provider` (discovery, code+PKCE, device, PAR, DPoP, revocation, introspection, pairwise).
- Canonical Principal IDs live in OpenSesame tables; Better Auth IDs are mapped via `better_auth_subjects`.
- No Clerk / Descope / Auth0 as core (ADR 0004). They may appear later only as external OIDC issuers.

## Consequences
Identity plane TypeScript packages under `packages/auth-upstream` and `packages/oauth-provider`.
