---
name: opensesame-mcps
description: Install, configure, initialize, and use OpenSesame MCP servers
---

# OpenSesame MCP servers

Ports for upstream APIs: Host **8787**, Identity **8788**, Daemon **18790**.
MCP HTTP transport (optional, mcp-host only): loopback **18791**.

The tool catalogs below are enforced by `packages/capability-registry`
(ADR 0065): each server's `registry-parity.test.ts` fails when this list and
the implementation drift, and the weekly agent-surface drift routine checks
this file against the registry.

## Install

```bash
pnpm install
# Both servers run from source (no build step):
#   apps/mcp-client — bin opensesame-mcp-client (node --import tsx src/server.ts)
#   apps/mcp-host   — bin opensesame-mcp-host   (node --import tsx src/server.ts)
```

## Configure

```bash
export OPENSESAME_HOST_API=http://127.0.0.1:8787     # client server
export OPENSESAME_SERVER=http://127.0.0.1:8787       # host server (preferred)
export OPENSESAME_DAEMON_URL=http://127.0.0.1:18790
export OPENSESAME_ACCESS_TOKEN=...                    # per-call, fail-closed
export OPENSESAME_ISSUER=http://127.0.0.1:8788        # identity claims (client)
export OPENSESAME_IDENTITY_TOKEN=...                  # present_claim only
# MCP never exposes L3 materialize / getSecret / sealed-store reveals
```

Optional Streamable HTTP for mcp-host (stdio stays the default):

```bash
export OPENSESAME_MCP_TRANSPORT=http
export OPENSESAME_MCP_HTTP_LISTEN=127.0.0.1:18791   # loopback only, enforced
export OPENSESAME_MCP_HTTP_TOKEN=<16+ char token>   # Bearer, transport-only
# Profile mcp-authorization-2026-07-28-bearer (ADR 0023): the inbound bearer
# authenticates the transport and is never forwarded downstream.
```

## Init

Register stdio servers in your MCP client config pointing at:

- `apps/mcp-client` — client-plane tools via `@opensesame/api-client`
- `apps/mcp-host` — operator tools against Host API / daemon (policy-gated)

## Use

Client tools (11): `host_health`, `host_discover`, `whoami`, `present_claim`,
`list_connections`, `integration_read`, `sync_target_read`,
`config_metadata_read`, `sync_push`, `sync_pull`, `invoke_l1`.

Host tools (32) — task authority: `task_start`, `task_list`, `task_status`,
`task_invoke`, `task_terminate`, `operator_invoke_l1`; posture: `host_ready`,
`daemon_status`, `backup_status`; receipts: `receipt_read`, `receipt_verify`;
delegations: `delegation_read`, `delegation_offer_read`, `delegation_narrow`,
`delegation_revoke`; relay: `relay_request_read`; providers/connections:
`provider_read`, `provider_test`, `connection_read`, `connection_rotate`,
`connection_remove`; certs: `cert_read`, `cert_issue`; configs: `config_read`
(metadata only), `config_set`, `config_rollback`; sync: `sync_target_read`,
`sync_push`, `sync_pull`; rotation: `rotation_read`, `rotation_trigger`;
changelog: `changelog_read`.

Every response passes a per-tool allowlist plus the `forAgent` fence; secret
values, leases, PEM key material, and TOTP seeds are structurally excluded.
Materialize / credential.resolve is forbidden by default (tests enforce this).
Approval ceremonies (relay approve/deny, delegation mint/claim, credential
entry) are human-only: headless MCP gets read-only inbox visibility; the PWA's
WebMCP tools open the ceremony UI instead.
