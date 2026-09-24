# @opensesame/console

The Identity console: a Vite + React web UI for the Identity API. It signs a
person in, approves a CLI or device by user code, completes ownership claims,
shows task access from the Host API, and lets an organization owner configure
upstream sign-in, email domains and SCIM provisioning.

## Where it fits

- **Used by:** operators and people signing in during local development
  (started by the root `pnpm dev`). [`apps/ceremonies`](../ceremonies) offers
  this origin when a ceremony is better finished signed in. Its bundle is
  budgeted in [`tools/quality/bundle-budgets.json`](../../tools/quality/bundle-budgets.json).
- **Builds on:** [`@opensesame/sdk-browser`](../../packages/sdk-browser)
  (sign-in, session, claims), [`@opensesame/api-client`](../../packages/api-client)
  (`normalizeLoopbackBaseUrl`), [`@opensesame/ceremony-kit`](../../packages/ceremony-kit),
  [`@opensesame/os-domain`](../../packages/os-domain).
- The operator bearer is sent only to a loopback gateway
  (`src/lib/urls.ts`, `operatorHeadersFor`), and a production build refuses to
  start if `VITE_OPENSESAME_OPERATOR_TOKEN` is set (`vite.config.ts`).
- A SCIM token is shown once, in the response that minted it, and cannot be
  shown again.

## Surface

| Route | Page | Talks to |
|---|---|---|
| `/` | `SignInPage` | Identity API sign-in |
| `/device` | `DevicePage` | Device authorization approval (`POST /v1/device/approve`) |
| `/claim` | `ClaimPage` | Ownership claims |
| `/task-access` | `TaskAccessPage` | Host API task access (`?task=`) |
| `/organization` | `OrgSignInPage` | Org upstream (OIDC or SAML), email domains, SCIM token |

Build-time variables: `VITE_OPENSESAME_ISSUER` (default
`http://127.0.0.1:8788`; `VITE_IDENTITY_API` is a fallback on some pages),
`VITE_OPENSESAME_GATEWAY` (default `http://127.0.0.1:8787`), and
`VITE_OPENSESAME_OPERATOR_TOKEN` for local development builds only.

## Develop

```bash
pnpm --filter @opensesame/console dev         # vite on :5173
pnpm --filter @opensesame/console build       # tsc -b && vite build
pnpm --filter @opensesame/console preview     # :5173
pnpm --filter @opensesame/console typecheck
pnpm --filter @opensesame/console test        # vitest run
```

`pnpm quality:bundle` builds this app and checks its bundle budget.

## Related

- [ADR 0008](../../docs/adr/0008-better-auth-oidc-provider.md) — Identity API stack
- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — Identity and Host APIs stay separate
- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — the console's device-approval link among the interaction surfaces
- [Architecture: identity plane](../../docs/architecture/identity-plane.md), [device auth](../../docs/architecture/device-auth.md)
- [Operators: identity administration](../../docs/operators/identity-administration.md)
