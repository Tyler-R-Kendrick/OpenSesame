# Routine: weekly-agent-surface-drift

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh
session with no memory of prior runs** — everything you need is below.

## Who you are and where you are

You are Claude Code, working alone in a fresh clone of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. OpenSesame is
a polyglot Rust + TypeScript monorepo whose agent surfaces (the MCP servers
`apps/mcp-host` and `apps/mcp-client`, and the WebMCP tools in
`apps/pages`/`apps/pwa`) must track everything the CLIs and PWAs can do.
`packages/capability-registry` is the enforced source of truth (ADR 0065:
`docs/adr/0065-agent-surface-parity.md`). Structural tests already fail when
an implemented tool list drifts from the registry — what they *cannot* see is
a feature that never gained a registry entry at all. That blind spot is your
job.

## Hard rules (apply on every firing, no exceptions)

- **This routine never becomes a GitHub Actions job.** `.github/workflows/`
  holds only `ci.yml` and `deploy-pages.yml`.
- **Never weaken an exclusion.** Registry entries excluded under ADR 0005 /
  0023 / 0052 (secret materialization, auth ceremonies, PM-plane bridging)
  stay excluded; do not map them to tools, and do not soften
  `assertsNoSecretNames` or the per-app denylists.
- **Never expose `getSecret()`, raw secret values, TOTP seeds, or
  credential-shaped payloads** anywhere you write.
- **No new dependencies.**

## What to sweep (diff the last week: `git log --since="8 days ago"`)

1. **New Host API routes**: `apps/gateway/src/routes/mod.rs` and handler
   modules. Any new `/api/v1/...` route group that no capability in
   `packages/capability-registry/src/index.ts` covers?
2. **New CLI verbs**: clap enums in `apps/cli/src/*.rs`, grammar in
   `packages/cli/src/parse.ts`. Any verb absent from every `surfaces.cli`
   string?
3. **New PWA surfaces**: `SECTIONS` in `apps/pages/src/components/AppShell.tsx`,
   new files under `apps/pages/src/sections/` or `apps/pages/src/lib/`,
   new actions in `apps/pwa/src/App.tsx`. Anything a user can now do that no
   capability's `pwa` surface names?
4. **New Identity API mounts**: `apps/control-plane/src/app.ts` mount table.
5. **Doc honesty**: `skills/opensesame-mcps/SKILL.md` tool lists still match
   `mcpHostCatalog()` / `mcpClientCatalog()`; ADR 0065 still describes the
   rules the tests actually enforce.

## What to do with a gap

For each uncovered feature, add a `Capability` entry to
`packages/capability-registry/src/index.ts` that either **maps** it onto the
agent surfaces (implementing the tool if it is a straightforward read that
follows the existing pattern in `apps/mcp-host/src/tools.ts` — Zod response
allowlist, `forAgent` fence, registry-parity test will force the catalog
update) or **excludes** it with a reason and an ADR citation. Run
`pnpm --filter @opensesame/capability-registry generate` to refresh
`capabilities.json`, then the verification below. If the right decision is
not obvious (a write with blast radius, a new secret-adjacent surface), file
the gap as a GitHub issue titled `agent-surface gap: <feature>` instead of
guessing — an explicit issue beats a wrong mapping.

## Verify before pushing

```bash
export NODE_OPTIONS="--max-old-space-size=8192"
pnpm --filter @opensesame/capability-registry test
pnpm --filter opensesame-mcp-host test && pnpm --filter opensesame-mcp-client test
pnpm --filter @opensesame/pages test && pnpm --filter @opensesame/cli test
cargo +1.88.0 test -p opensesame-cli --test capability_parity
pnpm lint && pnpm typecheck
```

Open a PR titled `chore(agent-surface): weekly drift sweep <date>` describing
each gap found and the map-or-exclude decision taken. If the sweep finds
nothing, do not open a PR and do not push.
