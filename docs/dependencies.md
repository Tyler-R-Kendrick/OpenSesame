# Identity plane dependencies

| Package | Purpose | License stance |
|---------|---------|----------------|
| better-auth | Upstream human auth adapter | MIT (verify pin) |
| oidc-provider | Downstream OAuth/OIDC AS | MIT |
| openid-client | RP/CLI OIDC | MIT |
| jose | JOSE/JWT/JWKS | MIT |
| hono | Control plane HTTP | MIT |
| zod | Contracts | MIT |
| drizzle-orm / drizzle-kit | Postgres schema | Apache-2.0 |
| vitest | Unit tests | MIT |
| @env-spec/parser | `.env.schema` (authority + identity) | MIT |
| pino | Logging (via observability) | MIT |

**Rejected for core:** Clerk, Descope, Auth0 Marketplace installs (ADR 0004, ADR 0008).

Generate SBOM: `pnpm generate:sbom`
