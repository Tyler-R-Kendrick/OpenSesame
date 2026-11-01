# Cloud agent environments

Generic cloud-agent environment notes moved from `AGENTS.md`. Harness-specific
model or subscription routing is intentionally not recorded here; configure it
in the harness, not in the repository.

## Cursor Cloud

This repository ships a Cursor-hosted Cloud Agent environment (managed VMs —
not a contributor's local machine). Image and bootstrap live in
[`.cursor/environment.json`](../../.cursor/environment.json) and
[`.cursor/Dockerfile`](../../.cursor/Dockerfile) (`rust:1.88.0-bookworm`,
aligned with `rust-toolchain.toml`). Harness-owned rule and tool files under
`.cursor/` describe that environment's own wiring.

- **Never run `sudo`** in agent commands (see `.cursor/rules/no-sudo.mdc`).
  The image includes `sudo` for platform tooling only.
- **Never commit API keys** or other secrets; inject them through the
  harness's secret store.

After checkout, `install` runs `.cursor/install.sh`. That script runs
`scripts/dev/dotfiles-bootstrap.sh` (personal mise and Grok, from
`DOTFILES_REPO` or `staging/tyler-dotfiles` when the clone fails), then
`mise install --locked` and `mise run deps` (fingerprinted `npm ci`), then
`cargo fetch`. Prefer the shared cargo target dir documented in
[shipping](shipping.md) when compiling Rust. Login and non-login shells
source `/etc/profile.d/mise.sh`, which prepends `/opt/mise/shims` and
defaults `CARGO_TARGET_DIR` to `$HOME/.cache/packages/cargo-target`.

## Devcontainer

`.devcontainer/devcontainer.json` builds on the pinned Rust devcontainer
image. The image installs the same checksum-pinned mise release as the
Cursor image. It does not use a Node feature, Corepack, or a pnpm store
volume. `updateContentCommand` and `postCreateCommand` install the locked
toolchain from `mise.toml` and `mise.lock` (`mise install --locked`), run
`scripts/dev/dotfiles-bootstrap.sh`, then `mise run deps` (`npm ci`).
`postCreateCommand` also runs `scripts/dev/setup-hooks.sh`.
`postStartCommand` still runs `scripts/dev/install-agent-skills.sh`.
