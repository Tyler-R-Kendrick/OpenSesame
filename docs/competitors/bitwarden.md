# Bitwarden — craft bar (human vault habits)

> Competitive reference for OpenSesame’s **on-device human store** UX habits
> ([PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md)). Never brand
> marks; never position OpenSesame as a Bitwarden replacement.

**Stance: craft bar** for human password-manager interaction patterns only
(folders, items, TOTP, autofill-ish flows). Product category remains an
authorization fabric with a sealed ceremony store — not a consumer password
vault.

## Overview

[Bitwarden](https://bitwarden.com/) is a widely adopted password manager
(clients + optional self-host / Vaultwarden-compatible servers). Humans store
logins, cards, identities, notes, and TOTP seeds; sync across devices; unlock
with master password / SSO / passkeys depending on deployment.

| Dimension | Bitwarden |
|-----------|-----------|
| Category | Human password manager (+ Secrets Manager SKU) |
| Trust model | Zero-knowledge vault encryption; server syncs ciphertext |
| Sync | Bitwarden cloud or self-hosted / Vaultwarden |
| Agent story | Weak for PM; separate Bitwarden Secrets Manager for DevOps |
| License | Clients GPL; server/commercial mix; Vaultwarden AGPL |

Distinguish **Password Manager** (human items) from **Bitwarden Secrets
Manager** (`bws`) — the latter is closer to Doppler/Infisical for machine
secrets and appears as a Host catalog provider (`bitwarden-sm`).

## Feature surface

- Vault items: login, card, identity, secure note, custom fields, folders.
- TOTP, passkeys (where supported), browser extension autofill.
- Org collections, policies, SSO for teams.
- Import/export JSON/CSV (Pages import maps Bitwarden JSON carefully).
- Secrets Manager: projects, machine accounts, `bws` CLI — not the same UX.

## Differentiators (why operators still pick Bitwarden)

- Best-in-class everyday human PM UX and browser extension ecosystem.
- Familiar unlock/sync model across phones and desktops.
- Self-host path (official or Vaultwarden) for privacy-conscious teams.

## Differentiators (why OpenSesame does not compete as a PM)

- Human store is for **ceremonies on this device** (Pages/OPFS), not a sync
  product promise.
- Agents never browse or reveal vault items — ConnectionRef only.
- Host connectors and sealed-store git history are first-class; Bitwarden PM
  is not an authorization fabric.

## OpenSesame mapping

| Bitwarden concept | OpenSesame |
|-------------------|------------|
| Vault item / folder | Pages vault item / folder |
| Unlock / master password | Pages unlock (WebCrypto); no brand clone |
| Browser extension autofill | Craft bar only — extension is Host/client, not a PM clone |
| Bitwarden JSON import | Pages import path (lossy for identity types) |
| Secrets Manager / `bws` | Catalog connector `bitwarden-sm` / `bitwarden` |
| Vaultwarden | Study / self-host prior art ([REUSE.md](../../REUSE.md)) |

Related: [DESIGN.md](../../DESIGN.md), Pages import notes in
[`apps/pages/README.md`](../../apps/pages/README.md).
