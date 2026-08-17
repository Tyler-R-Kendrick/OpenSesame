# Doppler — secrets platform (env delivery)

> Competitive reference for **centralized secrets → environment injection**
> workflows that developers compare to Host connectors and sealed-store CLI.

**Stance: adjacent competitor / craft bar** for “secrets as env for apps and
CI.” OpenSesame implements **capability parity** (projects-first scope,
multi-target sync, changelog, rotation, shared project secrets, offline
encrypted cache) under ConnectionRef / E2EE rules. It does **not** become a
Doppler clone. The catalog provider id `doppler` (Fnox parity) is a
**connector to Doppler SaaS** — not this feature set. Do not conflate them.

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
- Durable changelog + Host receipts; sealed-store git remains local ciphertext
  history ([ADR 0041](../adr/0041-projects-sync-targets-and-secret-changelog.md)).

## OpenSesame mapping

| Doppler / NATS ask | OpenSesame mapping |
|--------------------|--------------------|
| Sync to Vercel / Railway / etc. | Host **sync targets**: ConnectionRef → authorize → invoke fan-out; agents never receive raw secrets |
| Projects-first UX | First-class **Host Project** as secrets/env scope; default **personal project** binds initial sealed-store tomb + Pages vault folder |
| Automatic change logging | Durable **secret/config changelog** (identity audit chain + Host receipts + broker events); git commits remain sealed-store local history |
| Automated rotation | TaskBus jobs + broker credential versioning + sealed-store `pass update`-style rotate; schedules via JetStream |
| Shared project/env secrets | Project-scoped sealed entries + connection `shareability` / bindings (ADR 0032 / 0035) — not server-readable vault plaintext |
| Offline encrypted cache | Strengthen OPFS vault + sealed-store + client-core ciphertext blobs; encrypted snapshot export |
| NATS messaging / streaming | Real **JetStream adapter** behind `crates/task-bus` ([ADR 0042](../adr/0042-nats-taskbus-auth-callout-and-xkeys.md)) |
| NATS auth callout | **Host** callout (authz + ConnectionRef / OpenFGA); Identity only for principal mapping / token validation |
| Mixed-mode authn / authz | Multiple upstream IdPs via `PrincipalMappingStore`; **no email auto-link** |
| E2EE with xkeys | age / X25519 (sealed-store lineage) + human-vault AEAD for payloads — **never** the broker deployment seal key |

| Doppler concept | OpenSesame |
|-----------------|------------|
| Project / config | Host **Project** + `SecretConfig` (env scope) — ADR 0041 |
| `doppler run` | **Craft bar / operator L3 only** — never the agent contract; prefer authorize/invoke |
| Secret sync targets | Host **SyncTarget** → catalog connectors (Vercel, Railway, …), not shelling `doppler` CLI |
| Catalog entry | Provider `doppler` in connection broker catalog (SaaS connector only) |
| Branch configs / env roots | OpenSesame **branch-environments**: `env/development|staging|production` in a private recoverability repo ([ADR 0043](../adr/0043-environment-branch-git-backup.md)) — ciphertext trees, not SaaS-held values |

### Warning: do not clone `doppler run` as the agent API

Cloning env materialize (`doppler run`, Infisical-style `run`) as the default
agent path violates [ADR 0005](../adr/0005-authority-handle-connectionref.md) /
[ADR 0006](../adr/0006-env-spec-delivery-modes.md). Agents use ConnectionRef →
authorize → invoke → receipt. Operator materialize stays gated and audited.

Related: [REUSE.md](../../REUSE.md), Fnox parity catalog
(`connectors/fnox-parity.json`),
[connection broker](../architecture/connection-broker.md),
[TaskBus / NATS](../architecture/task-bus-nats.md).
