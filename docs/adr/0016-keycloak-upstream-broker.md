# ADR 0016 — Optional Keycloak for SAML/LDAP

## Status
Accepted

## Decision
Do not implement SAML/LDAP in OpenSesame. Optional Compose Keycloak profile brokers enterprise directories to OIDC; OpenSesame’s upstream contract remains generic OIDC (plus passkeys via Better Auth).

## Consequences
`deploy/compose` includes Keycloak; identity-plane mandatory tests use `apps/mock-upstream-idp` only.
