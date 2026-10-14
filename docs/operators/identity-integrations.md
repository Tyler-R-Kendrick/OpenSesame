# Identity integrations

Settings → Integrations → Identity offers BYO Identity, Better Auth, Supabase,
Neon Auth, Clerk, Auth0, WorkOS and Okta. Every provider composes the same
configuration, validation, sealed connection storage and sign-in controls.
Provider defaults and setup links come from
`spec/connectors/identity-presets.json`; regenerate the client data with
`node packages/app-core/scripts/emit-identity-presets.mjs` after changing it.

Save checks the adapter before recording configuration. A saved connection is
**configured**, not authenticated. Test connection checks discovery, signing
keys or the broker's saved configuration. Sign in must complete before the
connection reports a verified identity. Saved connections also appear as
sign-in choices at the unlock screen.

## Public OpenID Connect

Enter the issuer URL and registered public client ID. Register the displayed
redirect URI and browser origin with the provider; enable authorization code
with S256 PKCE and token endpoint authentication `none`. Scopes must include
`openid`. The app discovers endpoints, pins them to the issuer's origin, and
verifies the returned token's signature, issuer, audience and transaction.
Custom domains and issuers with paths use the same flow.

Clerk uses an OAuth application, not its backend API secret key. WorkOS uses
AuthKit Connect. Auth0 uses a Single Page Application; Okta uses a public
OIDC application and the authorization server's issuer URL. Better Auth's
OIDC mode requires its OAuth Provider plugin. Supabase's OIDC mode requires
its OAuth Server and a registered client.

## Better Auth and Neon Auth

Use the deployed auth API URL, including its mount path. A bare Better Auth
origin uses `/api/auth`; a Neon branch URL retains `/neondb/auth`. Enable
email/password, the JWT plugin, and credentialed CORS for the displayed
browser origin. Add that origin to Better Auth `trustedOrigins` or Neon's
trusted domains. Browser cookie restrictions still apply across unrelated
sites; use a same-site auth domain where required by your deployment.

The app signs in through `sign-in/email`, checks `get-session`, obtains the
JWT from `token`, and verifies its signature and subject. Better Auth uses
`jwks`; Neon uses `.well-known/jwks.json`. JWT issuer and audience default to
the auth origin. Expand token settings to supply a custom issuer, audience
or signing keys URL. Account passwords are transient and never saved as
connection configuration.

## Supabase Auth

Supply the project URL and publishable key, or a legacy `anon` key. Enable
the Email provider. The app signs in through `/auth/v1/token`, verifies the
user through `/auth/v1/user`, and validates token claims. Asymmetric projects
also verify the signature through the project's JWKS. Legacy HS256 tokens
are verified by the Auth service; no JWT signing secret belongs in this
public client. `service_role` and `sb_secret_` keys are rejected.

## SAML, LDAP and confidential OIDC

These protocols use an organization sign-in service because a static browser
cannot perform an LDAP bind or safely hold a confidential OAuth client.
Connect the sign-in service with the form's service control, authenticate as
an organization owner, and load the organization selector.

For SAML, provide the IdP entity ID and metadata URL or XML. Entity IDs may be
URNs. Register the displayed service-provider entity ID and assertion consumer
URL at the IdP. The broker validates signed assertions and creates membership
through its existing organization policy.

For LDAP, configure an `ldaps://` directory, a bind template or search bind,
the stable subject attribute, and optional profile attributes. Templates and
filters use `{username}`. Directory network access must be permitted by the
service's deployment policy. Search-bind credentials are write-only; editing
an unrelated field retains them, while changing the credential target requires
an explicit replacement. Sign in uses the broker's hosted directory form.

For confidential OIDC, enter the issuer, client ID and client secret and select
an organization. The secret is sent only to the configured broker, which
performs the upstream token exchange. Configuration changes require ownership;
ordinary members can take the saved sign-in route.

## Verification

`pnpm --filter @opensesame/pages build:identity-verify` builds a loopback
development deployment for the local fixture origin. Then run
`pnpm --filter @opensesame/pages verify:identity-connections`. It exercises
the real browser UI, real Better Auth and OIDC servers, a signed GoTrue
protocol fixture, configuration reloads and provider sign-out. The server
tests in `enterprise-configured-signin.test.ts` additionally configure and
complete native signed SAML and real LDAP binds. Hosted partner tenant
credentials are not required by these reproducible tests.
