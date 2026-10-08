---
name: opensesame-mcps
description: Install, configure, initialize, and use OpenSesame MCP servers
---

# OpenSesame MCP servers

Ports for upstream APIs: Host **8787**, Identity **8788**, Daemon **18790**.
MCP HTTP transport (optional, mcp-host only): loopback **18791**.

The tool lists below are the servers' own registries (`hostTools` in
`packages/mcp-host/src/tools.ts`, `toolsManifest` in
`packages/mcp-client/src/tools.ts`), which `packages/capability-registry`
holds to ADR 0065. Each server's `registry-parity.test.ts` fails when the
implementation, the registry or the lists in this file drift apart.

## Install

```bash
pnpm install
# Both servers are packages served by the client CLI (no build step):
#   opensesame-id mcp client   — packages/mcp-client
#   opensesame-id mcp host     — packages/mcp-host
```

## Configure

```bash
export OPENSESAME_HOST_API=http://127.0.0.1:8787     # both servers (spec/config/endpoints.json);
                                                      # https, or http on loopback only
export OPENSESAME_DAEMON_API=http://127.0.0.1:18790  # mcp-host only; loopback only
```

Neither server reads an operator token or a person's session
(`OPENSESAME_OPERATOR_TOKEN` and `OPENSESAME_ACCESS_TOKEN` are ignored by
design). Every authenticated call carries a short-lived agent capability
exchanged from a one-use launch handle, which only the native launch ceremony
hands out ([ADR 0099](../../docs/adr/0099-scoped-local-agent-authority.md)):

```bash
# The launching CLI reads OPENSESAME_OPERATOR_TOKEN (32+ characters) from its own environment.
opensesame --server <exact-host-origin> local-authority launch \
  --principal-id <principal> --organization-id <org> \
  --audience mcp-host \
  --capability <scope>[,<scope>] \
  --socket <absolute-daemon-socket> \
  --executable <absolute-mcp-executable> -- <arguments>
# The child gets OPENSESAME_AGENT_LAUNCH_HANDLE, OPENSESAME_AGENT_CLIENT_ID,
# OPENSESAME_AGENT_SOCK and the Host API address — nothing else inherited.
```

Optional Streamable HTTP for mcp-host (stdio stays the default):

```bash
export OPENSESAME_MCP_TRANSPORT=http
export OPENSESAME_MCP_HTTP_LISTEN=127.0.0.1:18791   # loopback only, enforced
export OPENSESAME_MCP_HTTP_TOKEN=<16+ char token>   # Bearer, transport-only
# Profile mcp-authorization-2026-07-28-bearer (ADR 0023): the inbound bearer
# authenticates the transport and is never forwarded downstream.
```

Optional mcp-host tool-call telemetry: `OPENSESAME_TELEMETRY_KEY`
(off unless set) and `OPENSESAME_TELEMETRY_HOST`.

## Init

Register stdio servers in your MCP client config with the client CLI's
commands (in the workspace, `pnpm --filter @opensesame/cli start -- mcp host`),
started through the launch ceremony above:

- `opensesame-id mcp client` (`packages/mcp-client`) — client-plane tools over
  the Host API
- `opensesame-id mcp host` (`packages/mcp-host`) — task authority, sync and
  health against the Host API and the daemon's liveness probe

## Use

### Client tools (5)

- `host_health` — Host API liveness, daemon probe and the tool manifest
- `whoami` — the agent capability's identity on the Host API
- `host_discover` — protected-resource metadata (issuers, DPoP posture)
- `sync_push` — push up to 64 opaque E2EE ciphertext blobs
- `sync_pull` — pull one bounded ciphertext page; continue with `next_after`

### Host tools (10)

- `task_start` — start a task under an immutable capability ceiling
- `task_status` — the ceiling against current capabilities for a task
- `task_invoke` — freeze a task-bound intent into the MCP task context
- `task_invoke_l1` — execute the frozen intent with the scoped agent capability
- `task_terminate` — end the task run
- `task_list` — the caller's task metadata, never intents or secrets
- `sync_push` — push ciphertext
- `sync_pull` — pull one bounded ciphertext page
- `host_ready` — Host API readiness
- `daemon_health` — daemon liveness (the only daemon route an agent reaches)

There is no receipt, delegation, relay, provider, connection, certificate,
secret-config, sync-target, rotation, changelog or backup tool on either
server: those are human administration or unscoped metadata, and
`packages/mcp-host/src/pact.test.ts` asserts their absence. Use the
`opensesame` CLI or the Pages PWA for them.

Every response passes the `forAgent` fence; secret values, leases, PEM key
material and TOTP seeds are structurally excluded. Materialize /
credential.resolve is forbidden (tests enforce this). Approval ceremonies are
human-only; the PWA's WebMCP tools open the ceremony UI instead.
