# @opensesame/oauth-provider

Downstream OAuth 2.0 / OpenID Connect authority built on panva [`oidc-provider`](https://www.npmjs.com/package/oidc-provider) (`9.x`).

## Features

- Authorization code + **PKCE required** (S256)
- Refresh tokens, device authorization, revocation, introspection, userinfo
- Pushed Authorization Requests (PAR)
- Resource indicators
- DPoP (enabled; replay rejected)
- **Pairwise** subjects via persisted mapping callback (`PairwiseSubjectStore`)
- `MemoryAdapter` for tests; `createPostgresAdapterConstructor` for production Postgres store
- Client admission: `pre_registered` default; origin / DCR / CIMD feature-gated
- `SafeMetadataFetcher` with SSRF denylist (localhost, private IPs, cloud metadata)

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OPENSESAME_ISSUER` | `http://127.0.0.1:3000` | Downstream issuer URL |
| `OPENSESAME_ORIGIN_CLIENTS_ENABLED` | `false` | Allow Shoo-compatible `origin_profile` clients |
| `OPENSESAME_DCR_ENABLED` | `false` | Enable Dynamic Client Registration |
| `OPENSESAME_CIMD_ENABLED` | `false` | Enable Client ID Metadata Document fetch (SSRF-hardened) |

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive).

## Usage

```ts
import {
  createOpenSesameProvider,
  createPostgresAdapterConstructor,
  MemoryPairwiseSubjectStore,
} from "@opensesame/oauth-provider";

const { provider, admission, metadataFetcher } = createOpenSesameProvider({
  issuer: process.env.OPENSESAME_ISSUER,
  clients: [/* pre-registered ClientMetadata */],
});
```

## Tests

```bash
pnpm --filter @opensesame/oauth-provider test
```
