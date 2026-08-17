# Doppler — secrets platform (env delivery)

> Competitive reference for **centralized secrets → environment injection**
> workflows that developers compare to Host connectors and sealed-store CLI.

**Stance: adjacent competitor / craft bar** for “secrets as env for apps and
CI.” OpenSesame may broker Doppler as a catalog provider; it does not become a
Doppler clone.

## Overview

[Doppler](https://www.doppler.com/) is a developer secrets platform organized
around projects, configs (environments), and sync targets. The Doppler CLI
injects secrets into local commands and CI; dashboards manage rotation,
sharing, and audit. Strong fit for twelve-factor apps that expect
`KEY=value` at process start.

| Dimension | Doppler |
|-----------|---------|
| Category | Cloud secrets platform + CLI/env sync |
| Trust model | Doppler-held secrets; service tokens / identity |
| Sync | Managed cloud; integrations to clouds and PaaS |
| Agent story | Indirect — inject env into agent runners |
| License | Proprietary SaaS |

## Feature surface

- Projects / configs / secrets hierarchy.
- `doppler run` / `doppler secrets` CLI for local and CI injection.
- Sync to Vercel, AWS, GitHub Actions, Kubernetes, etc.
- Change history, rollback, and team access controls.
- Appears in OpenSesame Host catalog as provider `doppler` (via Fnox parity).

## Differentiators (why operators still pick Doppler)

- Polished env-centric DX; minimal friction for Node/Rails twelve-factor apps.
- First-class sync into popular PaaS/CI without standing up Vault.
- Team onboarding centered on configs, not crypto or git trees.

## Differentiators (why OpenSesame wins a different slot)

- Authority fabric (ConnectionRef) rather than “dump env into process” as the
  agent contract.
- Git-native sealed store and device vault for humans.
- Dual Host/Identity planes; Doppler is not an IdP or OAuth connection broker.

## OpenSesame mapping

| Doppler concept | OpenSesame |
|-----------------|------------|
| Project / config | Host project + connection scopes (by role) |
| `doppler run` | Craft bar — prefer authorize/invoke for agents |
| Secret sync targets | Host connectors / capability connectors |
| Catalog entry | Provider `doppler` in connection broker catalog |

Related: [REUSE.md](../../REUSE.md), Fnox parity catalog
(`connectors/fnox-parity.json`).
