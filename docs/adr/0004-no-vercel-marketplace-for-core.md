# ADR 0004: Core identity is self-hosted OIDC, not Vercel Marketplace auth

## Status
Accepted

## Context
Vercel auth skill recommends Clerk. Product must be private, self-hostable, mesh-default, with Keycloak/external OIDC, device flow, and workload identity.

## Decision
Bundled Keycloak + generic OIDC. Clerk/Descope/Auth0 may be used later as *external* issuers via the same OIDC adapter, but are not required for core.

## Consequences
No Clerk SDK in the control plane. Web console authenticates through the same OIDC/device flows.
