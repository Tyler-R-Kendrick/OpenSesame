# Vercel Connect — adjacent (runtime connector tokens)

> Competitive reference for **short-lived, project-scoped third-party tokens**
> for apps and agents on Vercel — closest big-platform analog to “connectors
> without long-lived env secrets.”

**Stance: adjacent competitor / borrow-source** for connector + runtime token
UX. Distinct from Vercel Marketplace auth ([ADR 0004](../adr/0004-no-vercel-marketplace-for-core.md)):
Connect is credential brokerage; Marketplace is not OpenSesame’s IdP.

## Overview

[Vercel Connect](https://vercel.com/docs/connect) (beta) lets teams register
connectors to third-party APIs (OAuth or API key), attach them to projects /
environments, and request short-lived tokens at runtime via `@vercel/connect`
(`getToken`). Goal: agents and services act on Slack, GitHub, Linear, etc.
without storing long-lived provider secrets in env vars.

| Dimension | Vercel Connect |
|-----------|----------------|
| Category | Hosted connector / token broker (Vercel-tied) |
| Trust model | Vercel-held connector creds; OIDC to request tokens |
| Sync | Vercel project/env binding |
| Agent story | Strong — runtime tokens for agent workloads on Vercel |
| License | Proprietary platform feature |

## Feature surface

- Connector create/attach CLI (`vercel connect create|attach`).
- Vercel-managed vs customer-managed OAuth clients.
- Dedicated connectors (GitHub, Slack, Linear, …) + generic OAuth / API key.
- `getToken` / authorization helpers in `@vercel/connect`.
- Audit of authorization and token usage; webhook forwarding (limited beta).

## Differentiators (why operators still pick Vercel Connect)

- Zero infra if the app already lives on Vercel.
- Polished CLI + dashboard for 100+ connector services.
- Short-lived tokens beat static `PROVIDER_TOKEN` env vars for agents.

## Differentiators (why OpenSesame wins a different slot)

- **Plane-separated** Host + Identity — not locked to one PaaS.
- ConnectionRef → authorize → invoke → receipt; not only “hand me a provider
  token” (still powerful, but OpenSesame prefers capability invocation).
- Works offline/local (daemon, Pages, sealed store) without Vercel OIDC.
- ADR 0004: Marketplace auth is not core; Connect is studied as connector UX,
  not as OpenSesame’s identity provider.

## OpenSesame mapping

| Vercel Connect concept | OpenSesame |
|------------------------|------------|
| Connector | Host connection + catalog provider |
| `getToken` | Prefer invoke via ConnectionRef; tokens stay in Host |
| Project/env attach | Connection grants / capability bindings |
| OAuth consent | Host `authorizeConnection` + consent popup (Pages) |
| GitHub connector | History capability default + Sites/connections |

Related: [ADR 0004](../adr/0004-no-vercel-marketplace-for-core.md),
[ADR 0005](../adr/0005-authority-handle-connectionref.md),
Pages Capability connectors panel.
