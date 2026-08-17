# Nango — study (integration auth + functions)

> Competitive reference for **productized OAuth/API integration infrastructure**
> (auth, credential storage, syncs/actions, MCP). Listed in
> [REUSE.md](../../REUSE.md) as study only.

**Stance: study / adjacent** — Nango is how many SaaS products ship “connect
your customer’s GitHub/Slack.” OpenSesame’s Host connection broker overlaps on
auth and invoke; Nango’s productized Functions/sync layer is a different
business.

## Overview

[Nango](https://nango.dev/) is an integration platform: embed auth so end users
connect external APIs; run TypeScript **Functions** (actions, syncs, webhooks)
on Nango’s infrastructure; expose tools to agents via schemas/MCP. Supports
hundreds of APIs with templates; handles token refresh, retries, rate limits,
and tenant isolation. Open-source self-host path plus cloud.

| Dimension | Nango |
|-----------|-------|
| Category | Embedded integrations platform |
| Trust model | Nango-stored end-user credentials per connection |
| Sync | Continuous syncs + action triggers |
| Agent story | Strong — MCP / tool schemas over Functions |
| License | OSS + commercial cloud |

## Feature surface

- Frontend/backend SDKs for `nango.auth(...)` OAuth and API-key connects.
- 900+ API catalog; reusable templates and custom Functions.
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
- Study only — no incompatible source copy ([REUSE.md](../../REUSE.md)).

## OpenSesame mapping

| Nango concept | OpenSesame |
|---------------|------------|
| Integration + connection | Host provider + connection |
| `nango.auth` | Host authorize / Pages consent |
| Action / Function | Host invoke op + MCP tools |
| Sync/cache | Out of core scope (not a sync platform) |
| MCP tools | `apps/mcp-host` / `apps/mcp-client` |

Related: [oomol-open-connector.md](oomol-open-connector.md),
[vercel-connect.md](vercel-connect.md), [REUSE.md](../../REUSE.md).
