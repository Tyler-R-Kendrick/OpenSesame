# @opensesame/control-plane

The Identity API on `:8788`, the Identity plane's server. It is a Hono app
beside a panva oidc-provider issuer on one Node listener: OIDC and OAuth
protocol endpoints, upstream sign-in through Better Auth and federated
providers, canonical principals, passkeys and MFA, claims, device
authorization, organizations with SAML, LDAP and SCIM, agent authentication,
approvals and notifications. It is kept separate from the Host API; there is
no BFF merge.

## Where it fits

- **Used by:** [`apps/console`](../console), [`apps/ceremonies`](../ceremonies),
  [`apps/pwa`](../pwa) and [`apps/mobile-mfa`](../mobile-mfa) over HTTP; the
  example relying parties under [`examples/`](../../examples). The package
  also exports `createControlPlane`, `createHonoApp`, `loadConfig`,
  `startServer` and `buildOpenApiDocument` from `src/index.ts`.
- **Builds on:** [`oauth-provider`](../../packages/oauth-provider),
  [`auth-upstream`](../../packages/auth-upstream), [`claims`](../../packages/claims),
  [`device-auth`](../../packages/device-auth), [`database`](../../packages/database)
  (Drizzle, Postgres), [`policy`](../../packages/policy), [`audit`](../../packages/audit),
  [`notification-adapters`](../../packages/notification-adapters),
  [`os-domain`](../../packages/os-domain) and the rest of `package.json`.
- Canonical principals are OpenSesame domain models, not Better Auth user IDs.
  Identity and Host APIs stay separate
  ([ADR 0017](../../docs/adr/0017-host-client-product-topology.md)).

## Surface

`src/server.ts` splits each request: oidc-provider serves the protocol
endpoints and OIDC discovery, and Hono (`src/app.ts`) serves the rest.

| Area | Paths |
|---|---|
| Health | `/v1/health/live`, `/v1/health/ready` |
| Discovery | `/auth.md`, `/.well-known/agent-card.json`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` |
| Sign-in | `/v1/auth` (upstream), `/v1/federated`, `/v1/saml`, `/interaction` (oidc-provider slot), `/i` |
| Principals and projects | `/v1/principals`, `/v1/projects`, `/v1/organizations` (domains, LDAP, SCIM) |
| Authentication | `/v1/mfa`, `/v1/authentication`, `/v1/device`, `/v1/enrollment`, `/v1/siop` |
| Claims and OAuth clients | `/v1/claims`, `/v1/oauth/clients`, `/v1/oauth/applications`, `/v1/oauth/admin/*` |
| Authority and approvals | `/v1/authority`, `/v1/authorization-requests`, `/v1/approval`, `/v1/interactions`, `/v1/host-authorizations`, `/v1/agents` |
| Notifications | `/v1/notification-channels`, `/v1/notification-preferences`, `/v1/notification-callbacks`, `/v1/webhooks` |
| Other | `/v1/audit`, `/v1/support`, wallet-native mounts |

Source areas: `routes/` (one Hono router per area), `services/`,
`interactions/` (upstream sign-in legs), `middleware/`, `repos/` (durable
stores), `transport/` (optional mTLS listener and ingress evidence),
`ui/` (server-rendered ceremony pages), `openapi*.ts`.

Configuration is read in `src/config.ts`: port from
`OPENSESAME_CONTROL_PLANE_PORT` (or `PORT`, default `8788`), plus
`DATABASE_URL`, `OPENSESAME_ISSUER`, `OPENSESAME_CLAIM_PEPPER` and more; see
[`.env.schema`](../../.env.schema). Local development needs
`OPENSESAME_ENV=development` or `OPENSESAME_ALLOW_DEV_DEFAULTS=true`.

## Develop

```bash
pnpm --filter @opensesame/control-plane dev          # tsx watch src/server.ts
pnpm --filter @opensesame/control-plane start        # :8788
pnpm --filter @opensesame/control-plane typecheck
pnpm --filter @opensesame/control-plane test
pnpm --filter @opensesame/control-plane verify:siop
pnpm --filter @opensesame/control-plane test:authentication-browser   # e2e/, real Chromium
pnpm --filter @opensesame/control-plane generate:openapi              # writes openapi.json
```

`openapi.json` is generated; regenerate it (or run `pnpm generate:openapi` at
the root) after changing a route. Browser verifiers in `scripts/` run with
`pnpm --filter @opensesame/control-plane exec tsx scripts/<name>.mjs`.

## Related

- [ADR 0007](../../docs/adr/0007-dual-plane-identity-authority.md), [ADR 0008](../../docs/adr/0008-better-auth-oidc-provider.md), [ADR 0017](../../docs/adr/0017-host-client-product-topology.md), [ADR 0033](../../docs/adr/0033-federated-identity-admission.md) (federated admission), [ADR 0117](../../docs/adr/0117-hosted-siop-oidc-bridge.md) and [ADR 0119](../../docs/adr/0119-wallet-native-control-plane-composition.md) (SIOP, wallet-native), [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) (mTLS)
- [Architecture: identity plane](../../docs/architecture/identity-plane.md), [federated sign-in](../../docs/architecture/federated-signin.md), [claims](../../docs/architecture/claims.md)
- [Operators: authentication service](../../docs/operators/authentication-service.md), [identity administration](../../docs/operators/identity-administration.md)
