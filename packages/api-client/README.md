# @opensesame/api-client

The typed TypeScript client for the Host API (`crates/gateway`, `:8787`). One
factory, `createApiClient`, returns methods for connections, integrations,
sync targets, secret configs, invoke, sync, tasks, receipts, delegations,
relay, certificates, rotations, the project changelog and the backup target.
Responses are parsed with the `@opensesame/contracts` schemas.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core), [`packages/cli`](../cli),
  [`apps/console`](../../apps/console),
  [`apps/browser-extension`](../../apps/browser-extension),
  [`apps/mcp-client`](../../apps/mcp-client) and
  [`apps/mcp-host`](../../apps/mcp-host).
- **Builds on:** [`@opensesame/contracts`](../contracts) (response schemas),
  [`@opensesame/client-core`](../client-core) (sync blob and cursor types) and
  [`@opensesame/os-domain`](../os-domain).
- A base URL must be HTTPS, or HTTP on loopback; anything else throws at
  construction. `probeDaemon` only probes a loopback URL.
- DPoP proofs are opt-in (`dpop: true` or a supplied key pair), carry `ath`
  when a token is present, and retry only on an explicit nonce challenge.

## Surface

| Export | What it does |
|---|---|
| `createApiClient({ baseUrl, accessToken?, dpop?, fetchImpl? })` | The client; `ApiClient` is its type |
| Core methods | `health`, `discover`, `whoami`, `listProviders`, connection CRUD plus `authorizeConnection` / `refreshConnection` / `revokeConnection` / `bindConnection`, integrations, sync targets, secret configs and versions, `invoke`, `syncPush`, `syncPull`, `probeDaemon` |
| Mixed-in groups | `tasks.ts`, `receipts.ts`, `delegations.ts`, `relay.ts`, `certs.ts`, `rotations.ts`, `changelog.ts`, `backup.ts` |
| Helpers | `createDpopKeyPair`, `accessTokenHash`, `normalizeHttpBaseUrl`, `normalizeLoopbackBaseUrl`, `pullSyncPages`, `readSyncPage` |

## Develop

```bash
pnpm --filter @opensesame/api-client test
pnpm --filter @opensesame/api-client typecheck
```

The Host API's OpenAPI description is
[`spec/openapi/host-api.yaml`](../../spec/openapi/host-api.yaml).

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology; the Host and Identity APIs stay separate
- Server: [`crates/gateway`](../../crates/gateway)
