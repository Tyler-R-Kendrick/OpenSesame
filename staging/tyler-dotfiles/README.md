# Tyler Kendrick dotfiles

Personal, user-level setup for [Tyler Kendrick](https://github.com/Tyler-R-Kendrick).
This directory is the standalone tree for
[github.com/Tyler-R-Kendrick/dotfiles](https://github.com/Tyler-R-Kendrick/dotfiles).
It is staged inside the OpenSesame branch so the content can be reviewed
before that repository is published. It is not a nested git repository.

OpenSesame still contains the original files. Nothing was deleted there.
A later pull request hooks OpenSesame at this tree.

## Install

Unattended, rootless, and safe to re-run:

```bash
bash install.sh
```

The script writes only under `$HOME` (`~/.local`, `~/.config`, `~/.grok`,
`~/.cursor/rules`, `~/.claude`, `~/.kimi-code`, `~/.agents/skills`). It does
not elevate privileges. An existing file is left in place unless a stamp
under `~/.config/tyler-dotfiles/stamps/` shows this installer wrote it.

Devcontainer, Cursor cloud, and Codex or Claude remote sessions can point
their user dotfiles settings at this repository:

| Setting | Value |
| --- | --- |
| Repository | `Tyler-R-Kendrick/dotfiles` |
| Install command | `bash install.sh` |
| Target path | the clone of this repo |

Those environments already put `~/.local/bin` on `PATH` for non-interactive
shells. `install.sh` also links each mise tool into `~/.local/bin` and
sources `~/.config/tyler-dotfiles/env.sh` from `~/.bashrc` and `~/.profile`.

Node must already be on `PATH`. The devcontainer, the Cursor cloud image,
and Codex/Claude remote images provide it. The vendored installer uses that
Node only to download and checksum Grok Build and the Cursor Agent CLI.

## What install.sh installs

1. **mise `2026.10.18`**, from the GitHub release tarball. The archive is
   downloaded with `curl`, verified with SHA-256, then extracted. The
   linux-x64 and linux-arm64 digests are the ones in the OpenSesame Cursor
   image Dockerfile. macOS x64 and arm64 digests are from the same release's
   `SHASUMS256.txt`. The installer does not pipe a downloader into a shell.
   A second run skips the download when `~/.local/bin/mise` already reports
   that version.
2. **Latest personal dev tools** from `mise.toml`, installed into the user
   mise data dir and linked on `~/.local/bin`: `fd`, `github-cli` (`gh`),
   `jq`, `ripgrep` (`rg`), and `shellcheck`. Versions float to latest on
   each install. There is no lockfile.
3. **Grok Build** and the **Cursor Agent CLI**, via
   `vendor/install-cloud-cli.mjs` and `vendor/downloads.json`. The whole
   payload is checksum-pinned before it is installed or extracted. Grok
   lands at `~/.local/bin/grok`. Cursor Agent is linked as
   `~/.local/bin/cursor-agent` and `~/.local/bin/agent`.
4. **Grok subscription auth**, only when
   `GROK_SUBSCRIPTION_AUTH_SOURCE` (default
   `/cursor/stores/bot/grok/auth.json`) is a readable file. The copy goes
   to `~/.grok/auth.json` with mode `600`. A missing store is skipped.
   The script prints status lines only.
5. **User harness files** listed below, into the home directory.

OpenSesame's language toolchain (Node, Rust, Java, Go, pnpm) is a project
requirement. It is not in this `mise.toml`. Inside an OpenSesame checkout,
that repo's own `mise.toml` overrides any tool name both configs define.

Check the installer without network:

```bash
bash test/smoke-install.sh
```

## What moves out of OpenSesame

These are personal or operator settings. They are not product requirements.
The copies below are the export. OpenSesame paths are the originals, which
this branch does not delete.

| OpenSesame path | Staged path | Why it is personal |
| --- | --- | --- |
| `.cursor/rules/grok-build-first.mdc` | `harness/cursor/rules/grok-build-first.mdc` | Operator tier-1 routing adapter. The file says it is operator scope, not product policy. Installed to `~/.cursor/rules/`. |
| `.cursor/rules/kimi-first.mdc` | `harness/cursor/rules/kimi-first.mdc` | Operator tier-2 routing adapter. Installed to `~/.cursor/rules/`. |
| `.cursor/kimi-code.md` | `harness/cursor/kimi-code.md` | Operator runbook for Kimi subscription auth and the K3 model pin. |
| `docs/operators/kimi-code-cloud.md` | `harness/docs/kimi-code-cloud.md` | Operator cloud runbook for tier 2. Relative links still name OpenSesame paths. |
| `docs/contributing/agent-setup.md` (model routing, permissions, Stitch, skills) | `harness/docs/model-routing.md`, `harness/claude/settings.local.json`, `harness/claude/stitch-plugins.md`, `harness/shell/stitch-env.sh` | The prose described user-scope policy without a home. Permissions install to `~/.claude/settings.json`. Stitch plugins stay opt-in and are not enabled by `install.sh`. |
| `.grok/config.toml` | `harness/grok/config.toml` | The project file sets no settings and says auth and model routing are personal. Installed to `~/.grok/config.toml`. It does not set `auth.preferred_method`. |
| `scripts/dev/grok-headless.sh`, `grok-preflight.sh`, `grok-resolve-model.sh`, `grok-install-subscription-auth.sh`, `kimi-headless.sh`, `kimi-preflight.sh`, `agent-coding-preflight.sh` | `harness/scripts/` | Operator tier-chain helpers. Copied verbatim. They still call `scripts/dev/...` inside an OpenSesame checkout. `install.sh` does not copy them back into that repo. |
| `scripts/dev/install-cloud-cli.mjs`, `.cursor/tools/downloads.json` | `vendor/install-cloud-cli.mjs`, `vendor/downloads.json` | Checksum-pinned Grok and Cursor Agent installer. The vendored script reads `./downloads.json` so the tree does not depend on OpenSesame's layout. Logic otherwise matches the original. |

`docs/contributing/agent-setup.md` stays in OpenSesame as the contributor
guide. This export is the personal layer that guide describes.

Kimi Code's npm install remains on the OpenSesame cloud image (integrity-locked,
including the native `node-pty` build). This tree only carries the personal
`default_model` (`kimi-code/k3`), and only when `~/.kimi-code/config.toml`
does not already exist. `kimi login` owns that file after it writes providers.

## What stays a project requirement

These stay in OpenSesame. They are product adapters, not this dotfiles repo.

- `.claude/settings.json` and `.claude/hooks/` (product session and design hooks)
- `.codex/config.toml`, `.codex/hooks.json`, `.mcp.json`, `.cursor/mcp.json`, `opencode.json` (project MCP and UI hooks)
- Product Cursor rules: `anti-slop`, `design-system`, `evidence-persistence`, `local-debug`, `no-sudo`, `pages-voice`, `repository-footprint`
- `.github/copilot-instructions.md`
- `skills/`, `skills-lock.json`, and `scripts/dev/install-agent-skills.sh`
- `.devcontainer/`, `.cursor/Dockerfile`, `.cursor/install.sh`, and the project toolchain

## Layout

```text
install.sh                 rootless unattended installer
mise.toml                  personal tools at latest
vendor/downloads.json      pinned Grok and Cursor Agent payloads
vendor/install-cloud-cli.mjs
harness/                   exported user-level config and operator scripts
test/smoke-install.sh      bash -n plus pin checks
```
