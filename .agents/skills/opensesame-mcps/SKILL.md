---
name: opensesame-mcps
description: Install, configure, initialize, and use OpenSesame MCP servers
---

# OpenSesame MCP servers

Ports for upstream APIs: Host **8787**, Identity **8788**, Daemon **18790**.

## Install

```bash
pnpm install
pnpm --filter @opensesame/mcp-client build
pnpm --filter @opensesame/mcp-host build
```

## Configure

```bash
export OPENSESAME_HOST_API=http://127.0.0.1:8787
export OPENSESAME_DAEMON_URL=http://127.0.0.1:18790
# MCP never exposes L3 materialize / getSecret
```

## Init

Register stdio servers in your MCP client config pointing at:

- `apps/mcp-client` — client tools via `api-client` (health, connections, L1 invoke)
- `apps/mcp-host` — operator tools against Host API / daemon (policy-gated)

## Use

Client tools (examples): `host_health`, `list_connections`, `invoke_l1`.  
Host tools (examples): `daemon_status`, `host_ready`.

Materialize / credential.resolve is forbidden by default (tests enforce this).
