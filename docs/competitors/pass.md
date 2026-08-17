# `pass` (password-store) — direct competitor

> Competitive reference for OpenSesame’s **git-native sealed store**
> ([ADR 0037](../adr/0037-git-sealed-store.md)). Research notes against the
> classic Unix `pass` CLI (`password-store` / zx2c4).

**Stance: direct competitor** for the human CLI sealed-store path — not for the
Host authority plane, Identity API, or agent ConnectionRef model.

## Overview

[`pass`](https://www.passwordstore.org/) is the standard Unix password manager:
a thin CLI over a directory tree of GPG-encrypted files (default
`~/.password-store`), often versioned with git. Operators insert, show, list,
generate, copy, move, and remove secrets by path (`Folder/name`). Extensions and
ecosystem tools (browser helpers, `pass-otp`, mobile clients, `gopass`, etc.)
grew around the same tree shape.

| Dimension | `pass` |
|-----------|--------|
| Category | Local / git-backed CLI secret store |
| Trust model | GPG recipients; operator unlocks with their private key |
| On-disk root | `PASSWORD_STORE_DIR` or `~/.password-store` |
| Ciphertext | Typically `.gpg` (age forks/extensions exist) |
| Sync | Optional `pass git …` over the tree |
| Agent story | None — `pass show` reveals plaintext to whoever runs it |
| License | GPL-2.0+ (upstream password-store) |

OpenSesame’s sealed store deliberately speaks the same language: hierarchical
paths, git auto-commit, classic tree interop, and Host CLI verbs under
`opensesame pass` (`insert` / `show` / `ls` / …). That makes `pass` the product
an operator will A/B on a developer laptop when choosing “how do I keep CLI
secrets in git?”

## Feature surface (what operators compare)

### CLI verbs

Canonical `pass` verbs operators expect parity with:

| Verb | Role |
|------|------|
| `pass init` | Initialize store / set GPG recipients |
| `pass insert` / `pass generate` | Write secrets |
| `pass show` / `pass ls` / `pass find` | Read and navigate |
| `pass cp` / `pass mv` / `pass rm` | Tree edits |
| `pass git` | Commit / push / pull the ciphertext tree |
| `pass copy` (often via `xclip`/`wl-copy`) | Clipboard without printing |
| `pass otp` (pass-otp) | `opensesame pass otp` — trailer `otpauth://` + structured OTP |
| `pass update` (pass-update) | `opensesame pass update` — rotate first line; preserve trailer/OTP |
| pass-tomb / multi-store | `opensesame pass tomb` + optional `open`/`close` ([ADR 0038](../adr/0038-multi-tomb-sealed-store.md)) |

OpenSesame maps these to `opensesame pass …` verbs and
`opensesame pass init` ([ADR 0037](../adr/0037-git-sealed-store.md)).
Default root resolution mirrors `pass`: `OPENSESAME_STORE_DIR` →
`PASSWORD_STORE_DIR` → `~/.password-store`. Active tomb overrides when set.

### On-disk model

- One file per secret path; directory hierarchy is the namespace.
- Ciphertext is what gets committed; plaintext stays out of git when used as
  intended.
- Ecosystem assumes `.gpg` readability; some deployments add age.

OpenSesame reads classic trees (`.gpg` / `.age`) and prefers `.osseal` for new
writes when OpenSesame recipients/key material are present. Mixed trees in one
root are allowed.

### What `pass` does not do (and OpenSesame must not regress into)

- **No agent authority model.** Anyone who can run `pass show` gets the secret.
  OpenSesame agents never get `show` / `getSecret()` — only ConnectionRef →
  authorize → invoke → receipt ([ADR 0005](../adr/0005-authority-handle-connectionref.md)).
- **No dual-plane Host/Identity product.** `pass` is not an authorization
  fabric, OAuth broker, or connector host.
- **No Pages / OPFS human vault UI.** Browser habits are Bitwarden/1Password craft
  bar, not `pass`’s terminal UX.

## Differentiators (why an operator still picks `pass`)

- Ubiquity: installed by default muscle memory on many Unix boxes; huge
  extension ecosystem.
- Pure GPG mental model; no OpenSesame daemon, Host API, or Pages unlock.
- Tiny surface: a shell script + GPG, easy to audit in isolation.
- Existing trees and team workflows already standardized on `PASSWORD_STORE_DIR`.

## Differentiators (why OpenSesame wins the same slot)

- **Native engine** — no dependency on the external `pass` binary after ADR 0037;
  connector-host uses in-process sealed-store plans.
- **Format bridge** — `.osseal` plus classic `.gpg`/`.age` in one root.
- **Human + agent split** — Pages/OPFS vault and CLI store for humans; agents stay
  on ConnectionRef with no reveal affordance.
- **Product topology** — same operator can pair Host, Identity, Sites broker, and
  sealed store without treating `pass` as the authority plane.

## OpenSesame mapping

| `pass` concept | OpenSesame |
|----------------|------------|
| `~/.password-store` | Sealed-store root (`OPENSESAME_STORE_DIR` / `PASSWORD_STORE_DIR`) |
| `pass insert` / `show` / `ls` / … | `opensesame pass insert` / `show` / `ls` / … |
| `pass init` + GPG id | `opensesame pass init` + `.opensesame-key` / recipients |
| `pass git` | `opensesame pass git` + auto-commit on mutating verbs |
| `pass show` for scripts/agents | **Rejected for agents** — ConnectionRef only |
| `pass otp` / pass-otp | `opensesame pass otp`; Pages maps totp ↔ otpauth trailer |
| `pass update` | `opensesame pass update`; Pages single-item Update action |
| pass-tomb / Tomb volumes | Portable tomb registry + optional Linux `tomb` adapter ([tomb.md](tomb.md)) |
| Browser / phone UX | Pages vault (+ optional store manifest bridge), not a `pass` GUI clone |
| Shell-out provider | Retired — `HumanProviderPlan::SealedStore` |

Related: [ADR 0037](../adr/0037-git-sealed-store.md),
[ADR 0038](../adr/0038-multi-tomb-sealed-store.md),
[sealed-store design](../superpowers/specs/2026-08-15-git-sealed-store-design.md),
[AGENTS.md](../../AGENTS.md) sealed-store crib sheet.

## Deliberate non-goals vs `pass`

- Do not require the upstream `pass` binary for OpenSesame to function.
- Do not advertise OpenSesame as “a Bitwarden replacement”; against `pass` we
  compete on **CLI git-sealed secrets**, then extend into agent-safe authority
  that `pass` does not attempt.
- Keep the CLI group named `pass` so muscle memory matches Unix `pass`, while
  the binary remains `opensesame`.
