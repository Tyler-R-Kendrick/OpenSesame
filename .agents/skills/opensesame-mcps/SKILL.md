---
name: opensesame-mcps
description: Install, configure, initialize, and use OpenSesame MCP servers
---

# OpenSesame MCP servers

## Client MCP (`opensesame-mcp-client`)

Tools over Host **api-client**: `host_health`, `list_connections`, `invoke_l1`.

```bash
pnpm --filter @opensesame/mcp-client start
```

MCP config example:

```json
{
  "mcpServers": {
    "opensesame-client": {
      "command": "pnpm",
      "args": ["--filter", "@opensesame/mcp-client", "start"],
      "env": { "OPENSESAME_HOST_API": "http://127.0.0.1:8787" }
    }
  }
}
```

## Host MCP (`opensesame-mcp-host`)

Operator tools: `daemon_status`, `host_ready`.

```bash
pnpm --filter @opensesame/mcp-host start
```

Env: `OPENSESAME_HOST_API`, `OPENSESAME_DAEMON_URL`.

**Never** expose `getSecret` / materialize tools.
