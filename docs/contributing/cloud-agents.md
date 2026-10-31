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

After checkout, `install` runs `.cursor/install.sh` (`corepack` + the
fingerprinted frozen dependency install + `cargo +1.88.0 fetch`). Prefer the
shared cargo target dir documented in [shipping](shipping.md) when compiling
Rust. Login and non-login shells source `/etc/profile.d/cargo.sh`, which
prepends `/usr/local/cargo/bin` and defaults `CARGO_TARGET_DIR` to
`$HOME/.cache/packages/cargo-target`.
