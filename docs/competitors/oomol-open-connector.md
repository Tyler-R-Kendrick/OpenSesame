# Oomol Open Connector — adjacent (agent SaaS gateway)

> Competitive reference for **open-source agent ↔ SaaS connector gateways**
> that keep OAuth/API credentials out of the agent process. Closest OSS
> “Composio-class” peer to OpenSesame’s Host connection broker + MCP surfaces.

**Stance: adjacent competitor** for agent tool catalogs and credential
isolation. Study for catalog/Action contract patterns; do not copy incompatible
source ([REUSE.md](../../REUSE.md)).

## Overview

[Open Connector](https://github.com/oomol-lab/open-connector) (OOMOL Lab) is an
open-source connector gateway: users connect SaaS accounts once; agents and apps
call a large catalog of providers/Actions over SDK, CLI (`oo`), MCP, HTTP, or
OpenAPI. Credentials, OAuth, scopes, and run logs stay behind the gateway;
agents see schemas, connection aliases, and results — not raw tokens.
Deployments: self-host (Docker/Node), Cloudflare Workers, or OOMOL hosted.

| Dimension | Open Connector |
|-----------|----------------|
| Category | Agent SaaS connector gateway (OSS) |
| Trust model | Gateway-held credentials; runtime tokens for agents |
| Sync | SQLite / D1 / hosted control plane |
| Agent story | Primary — MCP + Actions catalog |
| License | Apache-2.0 (upstream) |

## Feature surface

- Large provider/Action catalog (GitHub, Gmail, Notion, Slack, …).
- OAuth2, API key, custom, and no-auth connection methods.
- Inspectable Action contracts (schemas, scopes, executor source).
- Runtime tokens, allow/block policies, redacted run logs, transit files.
- MCP server + OpenAPI + TypeScript SDK + web console.

## Differentiators (why operators still pick Open Connector)

- Huge prebuilt Action catalog aimed at agents day one.
- Apache-2.0 self-host without buying a PaaS connector product.
- Explicit “agent never holds provider token” messaging.

## Differentiators (why OpenSesame wins a different slot)

- Full **authorization fabric**: Identity plane, device login, receipts, policy
  (AuthZEN/OpenFGA), sealed human store — not only SaaS Actions.
- Host/client product topology and ConnectionRef as the durable contract.
- Git sealed store + capability connectors (encryption/history) for secrets
  that are not SaaS Actions.
- Polyglot WIT/Wasm core; Open Connector is primarily a Node/TS gateway.

## OpenSesame mapping

| Open Connector concept | OpenSesame |
|------------------------|------------|
| Provider / Action | Catalog provider + invoke ops |
| Connection alias | ConnectionRef / connection id |
| Runtime token | Host session / grant — never export provider secret |
| MCP surface | `apps/mcp-host` / `apps/mcp-client` |
| OAuth callback | Host authorize + consent |

Related: [nango.md](nango.md), [vercel-connect.md](vercel-connect.md),
[ADR 0005](../adr/0005-authority-handle-connectionref.md).
