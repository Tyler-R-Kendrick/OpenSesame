# @opensesame/mcp-client

The agent-facing MCP server on the Client plane, binary `opensesame-mcp-client`
over stdio. It gives a model a handful of Host API tools under a narrowly
scoped, short-lived agent capability from an approved local launch. It has no
tool that materializes a credential or reads a secret.

## Where it fits

- **Used by:** MCP-capable agents launched through an approved local agent
  launch. Setup: [skills/opensesame-mcps](../../skills/opensesame-mcps/SKILL.md).
- **Builds on:** [`@opensesame/agent-client`](../../packages/agent-client)
  (launch handle → agent capability headers),
  [`@opensesame/api-client`](../../packages/api-client),
  [`@opensesame/observability`](../../packages/observability) (`forAgent`
  redaction of every model payload), `@modelcontextprotocol/sdk`.
- No `materialize`, `get_secret` or `present_claim` tool may exist
  (`assertsNoMaterializeTool` in `src/tools.ts`,
  [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md)).
- Every authenticated call strips `authorization` and `x-opensesame-operator`,
  adds the agent capability headers, requires the exact Host origin and
  refuses redirects. The Host base must be HTTPS, or HTTP on loopback, or the
  server refuses to start.

## Surface

| Tool | What it does |
|---|---|
| `host_health` | Host API liveness, daemon probe and the tool manifest |
| `whoami` | The agent capability's identity on the Host API |
| `host_discover` | Protected-resource metadata (issuers, DPoP posture) |
| `sync_push` | Push up to 64 opaque E2EE ciphertext blobs |
| `sync_pull` | Pull one bounded ciphertext page; continue with `next_after` |

Environment: `OPENSESAME_HOST_API` (default `http://127.0.0.1:8787`), plus the
launch variables `@opensesame/agent-client` reads
(`OPENSESAME_AGENT_LAUNCH_HANDLE`, `OPENSESAME_AGENT_CLIENT_ID`,
`OPENSESAME_AGENT_SOCK`). Exports from `src/server.ts`: `buildServer`,
`main`, `requireBase`, `modelText`, `modelError`.

## Develop

```bash
pnpm --filter @opensesame/mcp-client start       # stdio server
pnpm --filter @opensesame/mcp-client typecheck
pnpm --filter @opensesame/mcp-client test        # vitest run
```

`src/registry-parity.test.ts` sweeps
[`@opensesame/capability-registry`](../../packages/capability-registry): a tool
added or removed here must match the registry
([ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Related

- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md), [ADR 0017](../../docs/adr/0017-host-client-product-topology.md)
- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent-surface parity
- [ADR 0099](../../docs/adr/0099-scoped-local-agent-authority.md) — scoped local agent authority
- [Audit: MCP response minimization](../../docs/security/audits/2026-08-22-mcp-response-minimization.md)
