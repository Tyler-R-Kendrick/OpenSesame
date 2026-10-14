# 0201: Identity integrations compose BYO adapters

Status: Accepted

## Context

Identity integration pages used generic connector contracts. Better Auth's
configuration-only catalog entry had no browser API route, so its page could
not collect or use a deployment's configuration. Administrative provider API
keys were also distinct from the user identity flows the product needed.
OIDC, signed SAML and LDAP authentication already existed elsewhere.

## Decision

Identity integrations share one protocol configuration model and one set of UI
components. BYO Identity exposes those protocols directly; partner presets
select protocols, setup guidance and defaults from one checked-in definition.
Adding a supported partner does not require another provider-specific form.

Public OIDC uses the existing federation flow with PKCE, transaction binding,
issuer-pinned endpoints and signed-token verification. Better Auth and Neon
compose the same session/JWT adapter, with Neon's documented signing-key path.
Supabase composes its token and authoritative user-verification adapter.
Confidential OIDC, native SAML and LDAP compose the existing organization
broker and retain its ownership, network, assertion and membership checks.

Configuration uses the atomic device-sealed connector ledger. Write-only
credentials remain private and are retained only for the same target. Public
sign-in settings reference the exact saved connection. A discovery or metadata
check does not authenticate an account or grant scopes; a connection reports
verified identity only after its saved sign-in flow succeeds.

## Consequences

The static application remains usable without a broker. A configured identity
provider is optional and does not replace the device's own identity. Partners
remain integrations, not dependencies of OpenSesame domain models or core
authentication infrastructure. Native enterprise protocols require a configured
organization service; browser-native flows require provider CORS and cookie
settings. Operator instructions and reproducible protocol tests document those
requirements explicitly.
