# @opensesame/mcp-host

The host-facing MCP server, binary `opensesame-mcp-host`, over stdio or
loopback Streamable HTTP. It gives a model task tools on the Host API — start
a task under an immutable capability ceiling, freeze an intent, execute it,
terminate — plus sync and health tools. Every authenticated call carries a
short-lived agent capability from an approved local launch; it never carries
the operator token, and there is no tool that reads a secret.

## Where it fits

- **Used by:** MCP-capable agents on the host. Setup:
  [skills/opensesame-mcps](../../skills/opensesame-mcps/SKILL.md).
- **Builds on:** [`@opensesame/agent-client`](../../packages/agent-client),
  [`@opensesame/api-client`](../../packages/api-client),
  [`@opensesame/observability`](../../packages/observability) (`forAgent`),
  [`@opensesame/telemetry`](../../packages/telemetry), `@modelcontextprotocol/sdk`.
- `assertsNoSecretTools` refuses any tool name matching `secret`,
  `materialize`, `pass_show` and similar
  ([ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md)).
- `hostFetch` refuses a caller-supplied `authorization` or
  `x-opensesame-operator` header, refuses redirects, and needs HTTPS off
  loopback. `daemonFetch` reaches only `GET /health/live` on a loopback daemon.
- The HTTP transport binds loopback only. Its inbound bearer authenticates the
  transport and is never read by a tool or forwarded.

## Surface

| Tool | What it does |
|---|---|
| `task_start` | Start a task with an immutable capability ceiling; returns `task_run_id` |
| `task_status` | Ceiling against current capabilities for a task |
| `task_invoke` | Freeze a task-bound intent into the MCP task context |
| `task_invoke_l1` | Execute the frozen intent with the scoped agent capability |
| `task_terminate` | End the task run |
| `task_list` | The caller's task metadata, never intents or secrets |
| `sync_push`, `sync_pull` | Push ciphertext; pull one bounded ciphertext page |
| `host_ready`, `daemon_health` | Host API readiness; daemon liveness |

| Variable | Meaning |
|---|---|
| `OPENSESAME_MCP_TRANSPORT` | `stdio` (default) or `http` |
| `OPENSESAME_MCP_HTTP_LISTEN`, `OPENSESAME_MCP_HTTP_TOKEN` | HTTP listener (default `127.0.0.1:18791`) and its bearer |
| `OPENSESAME_HOST_API` | Host API base (default `http://127.0.0.1:8787`) |
| `OPENSESAME_DAEMON_API` | Daemon base, loopback only (default `http://127.0.0.1:18790`) |
| `OPENSESAME_TELEMETRY_KEY`, `OPENSESAME_TELEMETRY_HOST` | Optional tool-call telemetry; off unless the key is set |

## Develop

```bash
pnpm --filter @opensesame/mcp-host start              # stdio server
pnpm --filter @opensesame/mcp-host typecheck
pnpm --filter @opensesame/mcp-host test
pnpm --filter @opensesame/mcp-host test:integration   # pact + tools suites
```

`src/registry-parity.test.ts` holds the tool list to
[`@opensesame/capability-registry`](../../packages/capability-registry)
([ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Related

- [ADR 0018](../../docs/adr/0018-standing-grants-vs-task-authority.md), [ADR 0019](../../docs/adr/0019-immutable-ceiling.md), [ADR 0021](../../docs/adr/0021-frozen-intent.md) — task authority, ceiling, frozen intent
- [ADR 0023](../../docs/adr/0023-mcp-bearer-vs-dpop.md) — MCP bearer vs DPoP
- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md), [ADR 0099](../../docs/adr/0099-scoped-local-agent-authority.md)
- [Audit: MCP response minimization](../../docs/security/audits/2026-08-22-mcp-response-minimization.md)
