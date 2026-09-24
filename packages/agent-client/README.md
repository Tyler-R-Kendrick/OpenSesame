# @opensesame/agent-client

The agent-side half of a local agent launch. A process started by an approved
launch exchanges its one-use launch handle for a short-lived agent capability
and turns it into request headers for the Host API. It never reads an operator
or session token; after one failed or expired acquisition it needs a new
approved launch.

## Where it fits

- **Used by:** [`apps/mcp-host`](../../apps/mcp-host) and
  [`apps/mcp-client`](../../apps/mcp-client).
- **Builds on:** [`@opensesame/observability`](../observability)
  (`registerAgentSecret`, so the handle and the token are redacted from logs)
  and `zod` for the grant shape.
- Reads `OPENSESAME_AGENT_LAUNCH_HANDLE` and `OPENSESAME_AGENT_CLIENT_ID`, and
  deletes the handle from `process.env` before the exchange.
- On Unix the exchange goes to the daemon's socket (`OPENSESAME_AGENT_SOCK`,
  `POST /v1/agent-capabilities/token`). The socket must be an absolute,
  canonical path, not a symlink, owned by the current user with mode `0600`
  or tighter. On Windows it posts to the Host's
  `/api/v1/agent-launches/token` with redirects refused.
- The Host resource must be an exact HTTPS origin, or an HTTP loopback origin.
  Responses are capped at 8 KiB; a grant lives at most 300 seconds.

## Surface

| Export | What it does |
|---|---|
| `AgentClient(audience, fetch?, socketExchange?)` | `headers(resource)` returns `authorization`, `x-opensesame-agent-client` and `x-opensesame-agent-audience`; `forget()` drops the grant |
| `AgentAudience` | `urn:opensesame:agent:mcp-host` or `urn:opensesame:agent:mcp-client` |
| `exactResource(raw)` | Normalizes a Host origin, or throws |
| `exchangeOnSocket(path, body)` (`src/uds.ts`) | The Unix-socket exchange, exported for tests |

## Develop

```bash
pnpm --filter @opensesame/agent-client test
pnpm --filter @opensesame/agent-client typecheck
```

`src/uds.test.ts` starts a real HTTP server on a Unix socket and checks the
symlink, permission and size refusals.

## Related

- [ADR 0099](../../docs/adr/0099-scoped-local-agent-authority.md) — short-lived
  local agent launch capabilities
- Daemon side: [`apps/daemon`](../../apps/daemon); Host side:
  [`apps/gateway`](../../apps/gateway)
