# @opensesame/auth-upstream

Upstream human authentication adapter for OpenSesame. Uses [`better-auth`](https://www.better-auth.com/) for session/passkey/OAuth mechanics; **canonical principal IDs** live in OpenSesame's mapping store — never Better Auth user IDs as downstream `sub`.

## Capabilities

- Better Auth factory (`createUpstreamAuth`) with **email account-linking disabled**
- `PrincipalMappingStore` — Better Auth user id → OpenSesame principal
- Anonymous / provisional sessions (`createProvisionalPrincipal`)
- Upgrade path preserves `principalId`
- Passkey seam with injectable `verifyAssertion` for tests
- Generic OIDC upstream provider registry (mock / Google / GitHub / Entra, …)
- **No email auto-link** (`noEmailAutoLinkPolicy`)

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OPENSESAME_AUTH_BASE_URL` | — | Better Auth `baseURL` (console / control-plane public URL) |
| `OPENSESAME_AUTH_SECRET` | — | Better Auth secret (min 32 chars in production) |
| `OPENSESAME_UPSTREAM_ISSUER` | `http://127.0.0.1:9090` | Default mock upstream issuer |
| `OPENSESAME_UPSTREAM_CLIENT_ID` | `opensesame-upstream` | Upstream RP client id |
| `OPENSESAME_UPSTREAM_CLIENT_SECRET` | `opensesame-upstream-secret` | Upstream RP client secret |
| `BETTER_AUTH_URL` | — | Alias accepted by Better Auth tooling if set |
| `BETTER_AUTH_SECRET` | — | Alias for `OPENSESAME_AUTH_SECRET` |

## Usage

```ts
import {
  createUpstreamAuth,
  MemoryPrincipalMappingStore,
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
  createProvisionalPrincipal,
} from "@opensesame/auth-upstream";

const mappingStore = new MemoryPrincipalMappingStore();
const registry = new UpstreamOidcProviderRegistry();
registry.register(mockUpstreamProvider());

const { auth, emailLinkPolicy } = createUpstreamAuth({
  baseURL: process.env.OPENSESAME_AUTH_BASE_URL!,
  secret: process.env.OPENSESAME_AUTH_SECRET!,
  mappingStore,
  providerRegistry: registry,
});
```

## Tests

```bash
pnpm --filter @opensesame/auth-upstream test
```
