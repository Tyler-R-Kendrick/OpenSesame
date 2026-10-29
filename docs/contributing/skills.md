# Skills index

Skills table moved from `AGENTS.md` §7. The canonical skill sources are `skills/*/SKILL.md` and `.agents/skills/`; this page is a routing index only. Ownership tiers (8 core first-party, 14 reusable-optional, 8 design-experiment-optional) are defined in `skills/profiles.json` and summarised in `skills/README.md`; core validation passes with optional profiles uninstalled.

## 7. Skills

Agent skills live under `skills/*/SKILL.md` (canonical). `.agents/skills/`
holds symlinks to the same directories for tools that look there instead.
Third-party skills (`impeccable` and the design skills below) are canonical
under `.agents/skills/`. Other harnesses use relative links for identical files
or directories, retaining their intentional agent-specific variants. Update the
canonical install once, then run `node scripts/dev/sync-agent-skills.mjs` and
its `--check` mode; do not refresh mirrored trees with multi-target `--copy`.

| Skill | Path | Purpose |
|-------|------|---------|
| `opensesame-apis` | `skills/opensesame-apis/SKILL.md` | Install, configure, initialize, and use OpenSesame Host and Identity APIs |
| `opensesame-chrome-extension` | `skills/opensesame-chrome-extension/SKILL.md` | Install, configure, initialize, and use the OpenSesame browser extension |
| `opensesame-clis` | `skills/opensesame-clis/SKILL.md` | Install, configure, initialize, and use OpenSesame host and client CLIs |
| `opensesame-mcps` | `skills/opensesame-mcps/SKILL.md` | Install, configure, initialize, and use OpenSesame MCP servers |
| `install-anti-slop` | `skills/install-anti-slop/SKILL.md` | Install and configure the vendored Oxlint anti-slop plugin |
| `security-review` | `skills/security-review/SKILL.md` | Run repository security gates and targeted Codex Security reviews |
| `visual-evidence` | `skills/visual-evidence/SKILL.md` | Compare two real builds for PR review; persist only approved current-state evidence in feature/project/platform slots |
| `local-debug-session` | `skills/local-debug-session/SKILL.md` | Attach a live HMR debug session when asked to run the app locally; watch real console/page/network errors and patch the hot-reloaded process |
| `impeccable` | `.agents/skills/impeccable/SKILL.md` | Third-party frontend design skill ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache 2.0), installed via `npx impeccable install` — lives in `.agents/skills/` (not `skills/`) so `npx impeccable update` can refresh it; design detector hook in `.codex/hooks.json` + `.claude/settings.local.json` (gitignored, machine-local) |
| `scandinavian-design` | `.agents/skills/scandinavian-design/SKILL.md` | Third-party ([ericzakariasson/scandinavian-design](https://github.com/ericzakariasson/scandinavian-design)), installed via `npx skills add ericzakariasson/scandinavian-design` — the visual-restraint contract behind the Scandinavian retoken; its `scripts/*.js` verifiers are patched to launch the container's pinned Chromium (`<chromium-binary>`) instead of a system Chrome |
| `design-taste-frontend` | `.agents/skills/design-taste-frontend/SKILL.md` | Third-party anti-slop frontend skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT; docs at [tasteskill.dev](https://www.tasteskill.dev/changelog)) |
| `design-system` | `.agents/skills/design-system/SKILL.md` | TypeUI `minimal` registry spec ([typeui.sh](https://www.typeui.sh/design-skills)), pulled via `npx typeui.sh pull minimal -f skill -p claude-code`; canonical under `.agents/skills/design-system/` |
| `gdp-ts` | `.agents/skills/gdp-ts/SKILL.md` (+ `.claude/skills/`) | Third-party ([rauchg/gdp-ts](https://github.com/rauchg/gdp-ts), MIT), installed once under `.agents/skills/gdp-ts/` and pinned in `skills-lock.json`; the workflow for adding or reviewing an authorization check as a compile-time proof (ADR 0178) — brand the id, one `proofs/` module per fact, a `*.mistakes.ts` per proof, no `as` to satisfy a proof |
| `shadcn` | `.agents/skills/shadcn/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([shadcn-ui/ui](https://github.com/shadcn-ui/ui/tree/main/skills/shadcn), MIT), installed once under `.agents/skills/shadcn/` and pinned in `skills-lock.json`; its `design-system.md` workflow turns `DESIGN.md` into a themed shadcn/ui design-system page in a scratch app (never `apps/pages`, which has no `components.json`); the shadcn MCP server (`shadcn@4.21.4 mcp`, stdio) is in every agent's MCP config (`docs/design/tooling.md` § shadcn) |
| `stitch-*`, `design-md`, `taste-design`, `enhance-prompt`, `site-md`, `stitch-loop` | `.agents/skills/<skill>/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills), Apache 2.0), installed once under `.agents/skills/`, linked to the other harnesses and pinned in `skills-lock.json`; Google Stitch prototyping over `.stitch/DESIGN.md` and the Stitch MCP server (`docs/design/tooling.md`) |

