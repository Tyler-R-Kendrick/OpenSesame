# fnox — peer (secrets CLI + provider matrix)

> Competitive reference for the **developer secrets CLI** that unifies local
> encryption and cloud providers behind `fnox.toml`. OpenSesame’s Host catalog
> embeds Fnox-parity provider ids for connector coverage.

**Stance: peer / compatibility** — study and catalog alignment; do not fork
fnox as the Host core. OpenSesame’s sealed-store CLI and ConnectionRef model
remain first-party.

## Overview

[fnox](https://fnox.jdx.dev/) (“Fort Knox for your secrets,” by jdx) is a CLI
that maps named secrets to providers: age/KMS for git-friendly ciphertext,
cloud secret managers, password managers (1Password, Bitwarden), Infisical,
Doppler, Vault, password-store, and more. Config lives in `fnox.toml`;
`fnox exec` / `fnox get` resolve values at use time. Designed to pair with
[mise](https://mise.jdx.dev/) without baking remote secret fetches into every
shell reload.

| Dimension | fnox |
|-----------|------|
| Category | Multi-provider secrets CLI |
| Trust model | Per-provider (age recipients, cloud IAM, PM unlock, …) |
| Sync | Git for encrypted values; remotes for cloud providers |
| Agent story | `fnox exec` injects env — still process-visible secrets |
| License | OSS (see upstream) |

## Feature surface

- `fnox.toml` providers + secrets; profiles and global config.
- Encryption providers: age, AWS/Azure/GCP KMS.
- Remote stores: AWS SM/PS, Azure/GCP SM, Vault, Doppler, Infisical, Bitwarden SM, …
- Password managers: 1Password, Bitwarden, Proton Pass, password-store, …
- CLI: `init`, `provider add`, `set`/`get`, `exec`, shell hooks.

OpenSesame’s Pages/Host embedded catalog imports Fnox-parity provider coverage
(`connectors/fnox-parity.json`) so operators see the same connector universe.

## Differentiators (why operators still pick fnox)

- One TOML + CLI across many backends; excellent local DX with mise.
- Age-in-git path without standing up a platform.
- Lightweight — no OpenSesame Host/Identity required.

## Differentiators (why OpenSesame wins a different slot)

- Authorization fabric and receipts, not only secret resolution.
- Agent-safe ConnectionRef (no default env materialization for agents).
- Pages vault + capability connectors (encryption / git history) as product UI.
- Native `opensesame pass` sealed store (`.osseal` / classic tree).

## OpenSesame mapping

| fnox concept | OpenSesame |
|--------------|------------|
| Provider type ids | Host catalog provider ids (Fnox parity) |
| `fnox exec` | Craft bar for humans/devs; agents use ConnectionRef |
| age / password-store providers | Sealed-store + encryption capability connectors |
| `fnox.toml` | Not adopted as Host config — `.env.schema` / settings instead |

Related: [`connectors/fnox-parity.json`](../../connectors/fnox-parity.json),
[`apps/pages/src/lib/embedded-catalog.ts`](../../apps/pages/src/lib/embedded-catalog.ts).
