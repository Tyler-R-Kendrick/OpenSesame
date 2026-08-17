# Infisical — craft bar (agent secret delivery)

> Competitive reference for OpenSesame’s **authority / agent delivery** craft
> bar ([PRODUCT.md](../../PRODUCT.md)). Not a password-manager clone.

**Stance: craft bar** for agent/secret injection workflows (`infisical run`,
Agent Proxy). OpenSesame aims at the same *operator habit* — inject authority
into a process without teaching agents to `getSecret()` — without becoming an
Infisical product or copying brand marks.

## Overview

[Infisical](https://infisical.com/) is an open-core secrets platform: projects,
environments, machine identities, CLI injection (`infisical run`), and an Agent
Proxy that keeps secrets out of application config by mediating access at
runtime. Teams use it as a centralized secret store plus delivery path for
apps, CI, and agents.

| Dimension | Infisical |
|-----------|-----------|
| Category | Secrets platform + agent/runtime injection |
| Trust model | Server-held secrets; identities / tokens unlock delivery |
| Sync | Cloud or self-hosted control plane |
| Agent story | Strong — `run` / proxy inject env or mediate fetches |
| Human vault UI | Secondary to platform secrets, not Bitwarden-class UX |
| License | Open-core (OSS + commercial) |

## Feature surface (what operators compare)

- Project / environment scoped secrets and folders.
- CLI: login, secret pull/push, `infisical run <cmd>` to inject into a child process.
- Machine identities, service tokens, and (where enabled) Agent Proxy.
- Integrations across clouds, CI, Kubernetes, and developer tools.
- Self-host and SaaS deployment modes.

OpenSesame’s Host plane answers a related question with a different contract:
ConnectionRef → authorize → invoke → receipt ([ADR 0005](../adr/0005-authority-handle-connectionref.md)),
not env injection as the primary agent API.

## Differentiators (why operators still pick Infisical)

- Mature secrets *platform* UX (projects, envs, audit, team RBAC).
- Drop-in `infisical run` for existing apps that expect env vars.
- Broad CI/K8s/cloud sync ecosystem already adopted by many teams.

## Differentiators (why OpenSesame wins a different slot)

- **Dual plane** — Host authorization fabric + Identity API; Infisical is not an
  OIDC/Identity product topology ([ADR 0017](../adr/0017-host-client-product-topology.md)).
- **No agent reveal** — agents never get plaintext via `show` / `getSecret()`.
- **Device human store** — Pages/OPFS vault for ceremonies; Infisical is not the
  Bitwarden craft bar.
- **Git sealed store** — `opensesame pass` / `.osseal` for local git ciphertext
  ([ADR 0037](../adr/0037-git-sealed-store.md)).

## OpenSesame mapping

| Infisical concept | OpenSesame |
|-------------------|------------|
| Project secrets | Host connections + sealed store / vault items (by role) |
| `infisical run` env injection | Craft bar only — prefer ConnectionRef invoke over env dump |
| Agent Proxy | Host authorize → invoke; receipts for audit |
| Machine identity | Device / workload auth + connection grants |
| Human password UI | Pages vault habits (Bitwarden craft bar), not Infisical |

Related: [PRODUCT.md](../../PRODUCT.md), [REUSE.md](../../REUSE.md) (study only),
catalog provider `infisical` in Host connector catalog.
