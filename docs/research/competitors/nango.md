# Nango — study (integration auth + functions)

> Competitive reference for **productized OAuth/API integration infrastructure**
> (auth, credential storage, syncs/actions, MCP). Listed in
> [docs/reference/reuse.md](../../reference/reuse.md) as study only.

**Stance: study / adjacent** — Nango is how many SaaS products ship “connect
your customer’s GitHub/Slack.” OpenSesame’s Host connection broker overlaps on
auth and invoke; Nango’s productized Functions/sync layer is a different
business.

## Overview

[Nango](https://nango.dev/) is an integration platform: embed auth so end users
connect external APIs; run TypeScript **Functions** (actions, syncs, webhooks)
on Nango’s infrastructure; expose tools to agents via schemas/MCP. Supports
1,000+ APIs with templates; handles token refresh, retries, rate limits,
and tenant isolation. Self-host path (limited feature set upstream) plus cloud.

| Dimension | Nango |
|-----------|-------|
| Category | Embedded integrations platform |
| Trust model | Nango-stored end-user credentials per connection |
| Sync | Continuous syncs + action triggers |
| Agent story | Strong — MCP / tool schemas over Functions |
| License | Elastic License (source-available) + commercial cloud |

## Feature surface

- Frontend/backend SDKs for `nango.auth(...)` OAuth and API-key connects.
- 1,000+ API catalog; reusable templates and custom Functions.
- Unified APIs (optional): code-owned models mapping many providers.
- Schedules, webhooks, retries, observability, environments.
- MCP / agent tool exposure for selected actions.

## Differentiators (why operators still pick Nango)

- Built to embed *inside* a SaaS product’s customer-facing integrations.
- Sync engine and Function runtime — more than token brokerage.
- Huge API template library and AI-assisted Function authoring.

## Differentiators (why OpenSesame wins a different slot)

- OpenSesame is the **operator’s** authorization fabric and sealed store — not
  primarily an embeddable “ship integrations for your customers” SaaS.
- Dual Host/Identity planes, device login, Pages vault, git sealed store.
- ConnectionRef emphasizes capability invocation and receipts over syncing CRM
  records into a cache.
- Nango's source is studied only — no incompatible source copy
  ([docs/reference/reuse.md](../../reference/reuse.md)); its public listing
  routes are read, not depended on (see the mapping).

## OpenSesame mapping

| Nango concept | OpenSesame |
|---------------|------------|
| Integration + connection | Host provider + connection |
| `nango.auth` | Host authorize / Pages consent |
| Action / Function | Host invoke op + MCP tools |
| Sync/cache | Out of core scope (not a sync platform) |
| MCP tools | `packages/mcp-host` / `packages/mcp-client` |
| Environment with connections already authorized | A **Nango-compatible directory**, read by reference ([ADR 0115](../../adr/0115-front-door-and-connector-directory.md)): `packages/app-core/src/lib/nango-directory.ts` calls `GET /integrations` and `GET /connections` (older servers: `/connection`) with an environment key and keeps integration, connection id, end user and health. It never calls the route that returns credentials (`GET /connection/{id}`, now `GET /connections/{connectionId}` upstream) and depends on no Nango package. Setup's connectors tab and Connections › Import connectors read it; Access › Connectors binds grants to what it lists |

Related: [oomol-open-connector.md](oomol-open-connector.md),
[vercel-connect.md](vercel-connect.md), [docs/reference/reuse.md](../../reference/reuse.md).
