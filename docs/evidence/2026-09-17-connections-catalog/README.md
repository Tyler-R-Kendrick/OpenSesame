# Connections catalog — Managed group and Vercel browse tiles

Before/after from two real Pages builds walked the same way: guest →
Connections. Phone 390×844 and desktop 1280×800.

| Sheet | Before | After |
|---|---|---|
| `390-connections.png` | Connected empty state is **No Host connected**; catalog starts at Encryption | **Nothing connected**; **Managed** leads (GitHub, Linear, Linq, Microsoft) with **Not configured** chips |
| `1280-connections.png` | Rail `Add a connection` count **40**; catalog starts at Encryption (age, FIDO2, YubiKey) | Rail `Add a connection` count **155**; **Managed** grid then **Identity** (Auth0, Clerk, Okta); Custom connector in the panel head |

## What this proves

- Catalog grouping leads Managed, then Identity / Backup/recovery, not Encryption.
- Host is optional: the empty connected state no longer names a missing Host.
- Browse tiles stay listed (Not configured); Custom connector remains a control
  in the catalog head.

## How

`connections-catalog.json` in this directory. Chromium via `PLAYWRIGHT_CHROMIUM`.
The before build also restored `packages/contracts/src` from `origin/main` so
Pages typecheck against the base category enum.
