# ADR 0016 — Optional Keycloak for SAML/LDAP

## Status
Accepted (partly superseded by [ADR 0056](0056-native-saml-scim-and-directory-federation.md)
for the SAML service-provider half and [ADR 0057](0057-email-linking-better-auth-and-ldap.md)
for LDAP; the Keycloak-brokered path remains supported)

## Decision
Do not implement SAML/LDAP in OpenSesame. Optional Compose Keycloak profile brokers enterprise directories to OIDC; OpenSesame’s upstream contract remains generic OIDC (plus passkeys via Better Auth).

## Consequences
`ops/compose` includes Keycloak; identity-plane mandatory tests use `tools/mock-upstream-idp` only.
