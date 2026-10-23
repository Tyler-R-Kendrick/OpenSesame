# .claude

`hooks/session-start.sh` is inert unless `OPENSESAME_AGENT_BOOTSTRAP=1` explicitly
requests dependency bootstrap. Remote-session flags alone do not authorize an
installation. The hook refuses production-shaped credentials as before.

An opted-in session runs `scripts/dev/install-dependencies.sh`. The shared helper
uses `pnpm install --frozen-lockfile` only when its tracked package manifests,
patches, lockfile or workspace configuration differ from the last successful
installation, or when pnpm's module manifest is absent. Its small fingerprint
lives in ignored `node_modules/.cache/`; dependency stores remain shared. Cursor's
explicit environment setup uses the same helper.

Session startup never generates database schemas, migration snapshots, reports,
baselines or other tracked files. Run `pnpm db:generate` deliberately after a
schema change and review the generated migration. Database migrations never run
automatically. Clear the ignored install fingerprint to request a repair install.
Do not delete shared stores or download a second browser/toolchain cache to make
an agent session fresh.

Native dependency selection is declared in `package.json` using pnpm's
`supportedArchitectures` with `os`, `cpu` and `libc` set to `current`. pnpm 9
needs full registry metadata to include libc constraints in the lockfile.
Refresh that metadata during an intentional dependency update; an old lockfile
without libc fields can still install both variants. Do not manually remove
installed native packages or count potential savings as already reclaimed.

Devcontainer setup installs dependencies without an eager Rust build. Rust
commands use the shared `CARGO_TARGET_DIR` cache when a task actually needs them.
