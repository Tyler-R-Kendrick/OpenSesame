# Identity plane dependencies

| Package | Purpose | License stance |
|---------|---------|----------------|
| better-auth | Upstream human auth adapter (`packages/auth-upstream`) | MIT |
| @simplewebauthn/server | WebAuthn ceremonies for the upstream adapter | MIT |
| oidc-provider | Downstream OAuth/OIDC AS (`packages/oauth-provider`) | MIT |
| openid-client | OIDC relying-party leg to upstream IdPs | MIT |
| @node-saml/node-saml | SAML service-provider sign-in | MIT |
| ldapts | LDAP bind and directory sync | MIT |
| nodemailer | Outbound email (SMTP transport) | MIT-0 |
| jose | JOSE/JWT/JWKS | MIT |
| hono / @hono/node-server | Control plane HTTP | MIT |
| zod | Contracts | MIT |
| @gdp-ts/core | Authorization proofs the compiler can see (ADR 0178) | MIT |
| drizzle-orm / drizzle-kit | Postgres schema | Apache-2.0 / MIT |
| vitest | Unit tests | MIT |
| @env-spec/parser | `.env.schema` parsing (`packages/env-spec-bridge`, consumed by `crates/env-spec`) | MIT |
| pino | Logging (via observability) | MIT |

**Rejected for core:** Clerk, Descope, Auth0 Marketplace installs (ADR 0004, ADR 0008).

Generate SBOM: `pnpm generate:sbom`
