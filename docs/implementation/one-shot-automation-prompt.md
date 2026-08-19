# One-shot prompt: OpenSesame AI-automation build-out (parallel subagents)

> Copy everything below the line into a coding agent that can spawn parallel subagents
> (isolated worktrees recommended). It is self-contained: no other conversation or
> document is required.

---

## Mission

You are the orchestrator. Implement the complete AI-automation build-out for the
OpenSesame repository in one run by delegating the nine work packages below to
parallel subagents. The packages are deliberately independent — **no ordering, no
phases**: each package owns a disjoint set of files, carries its full spec, and
self-verifies. Spawn all nine at once, merge their results, run the final
acceptance checks, and commit.

## Hard rules (every subagent inherits these verbatim)

1. **Zero GitHub Actions.** Do not create `.github/` or any workflow file, and do
   not add anything that consumes Actions runner minutes — not for CI, not for
   deploy, not for review. All verification is local scripts + git hooks; all
   recurring automation is documented as Claude Code cloud scheduled sessions
   (subscription-billed, not Actions); PR review is CodeRabbit (already
   installed on the repo, runs on its own infra).
2. **No new paid services or paid features.** Do not enable GitHub Copilot
   anything, paid Vercel features, or any usage-billed integration. Free
   open-source npm/cargo devDependencies are allowed.
3. **No secrets in git.** Follow the `.env.schema` pattern (env-spec annotations:
   `@type`, `@required`, `@sensitive`, `@public`). Dev behavior must be off or
   dev-defaulted unless the operator opts in.
4. **Respect the repo's design rules:** `@opensesame/os-domain` must not import
   Better Auth, oidc-provider, Hono, Drizzle, or React; prefer mature libraries
   over NIH protocol code (ADR 0008); identity plane (`:8788`) and host plane
   (`:8787`) stay separate (ADR 0017); never expose raw secrets, private proof
   keys, or `getSecret()` affordances; no sudo.
5. **Do not touch Rust code or `Cargo.*`.** This build-out is
   tooling/TS/docs-only.
6. **Formatting/lint:** Biome 1.9.4, 2-space indent (`pnpm lint:fix` before
   finishing). TypeScript 5.8.3 strict, `"type": "module"` everywhere.
   Conventional-commit messages (`feat(scope): …`, `docs(scope): …`).
7. **File ownership is exclusive.** A subagent may read anything but may only
   create/edit the files its package lists under OWNS. The root `package.json`
   is owned by WP2 alone.

## Repository ground truth (verified at commit `0608ccc`)

- Monorepo: pnpm 9.15.0 (Corepack), Node ≥ 22, Turbo 2.9.14, Biome, Vitest
  4.1.10, Playwright 1.55.1 (already a root devDependency), Rust 1.88 workspace
  (leave alone). `pnpm-workspace.yaml` globs include `packages/*` — a new
  directory under `packages/` joins the workspace automatically.
- Product: dual-plane authorization fabric. Host API `apps/gateway` (Rust,
  `:8787`), daemon (`:18790`), Identity API `apps/control-plane` (TS Hono +
  Better Auth + oidc-provider, `:8788`), mock IdP (`:9090`). Client surfaces:
  `apps/pages` (offline-first vault PWA, Vite dev port **5180**, name
  `@opensesame/pages`, React 19 + react-router 8 + vite-plugin-pwa; src layout:
  `src/App.tsx`, `src/pages/`, `src/components/`, `src/lib/`), `apps/pwa`,
  `apps/browser-extension` (WXT), `apps/console`. MCP servers:
  `apps/mcp-host` (`@opensesame/mcp-host`, `@modelcontextprotocol/sdk` 1.30.0 +
  zod, entry `src/server.ts`, started with `node --import tsx src/server.ts`)
  and `apps/mcp-client`.
- Commands: `pnpm bootstrap` (install + db generate/migrate), `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm verify`, and
  security gates `pnpm audit:{cve-lite,ast-grep,clippy,osv,cargo-audit,gitleaks,semgrep}`
  backed by `scripts/*-gate.sh`. `pnpm generate:openapi` writes
  `apps/control-plane/openapi.json`.
- Known state to fix (all verified absent/true at `0608ccc`):
  - **No `.github/` directory exists and none may be created** (see hard rule 1).
  - **No root `CLAUDE.md` or `AGENTS.md` exists.**
  - `skills/` and `.agents/skills/` are **byte-identical duplicate trees**, each
    holding four skills: `opensesame-apis`, `opensesame-chrome-extension`,
    `opensesame-clis`, `opensesame-mcps` (one `SKILL.md` each).
  - `PRODUCT.md` references `scripts/deploy-pages.sh`, which **does not exist**.
  - `docs/security/tooling-evaluation.md` finding 0d claims gates were "wired
    into CI `security` job" — untrue at this commit.
  - **No `.claude/` directory exists.**
  - `.impeccable/design.json` is the design contract; `.impeccable/screenshots/`
    holds six baselines: `pages-desktop.png`, `pages-mobile.png`,
    `vault-list-desktop.png`, `vault-list-mobile.png`, `vault-unlock-desktop.png`,
    `vault-unlock-mobile.png`.
  - Key docs: `docs/adr/0001–0031`, `docs/security/security-boundaries.md`,
    `docs/security/threat-model.md`, `docs/security/identity-threat-model.md`,
    `docs/testing-evidence.md`, `docs/brief-implementation-status.md`,
    `docs/ai-automation-roadmap.md` (a planning doc this build-out implements).
  - PR review is already handled by CodeRabbit (installed GitHub App).
  - The identity plane requires `OPENSESAME_ENV=development` or
    `OPENSESAME_ALLOW_DEV_DEFAULTS=true` locally; `OPENSESAME_CLAIM_PEPPER`
    required outside dev/test; Postgres via `DATABASE_URL`.

---

## WP1 — Root agent context files

**OWNS:** `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`

Create a root `AGENTS.md` (~150–250 lines) that makes any coding agent
productive without spelunking. Required sections, all content derived by
reading the repo (do not invent):

1. **What this is** — dual-plane authorization fabric; one-paragraph topology
   with ports 8787/8788/18790/9090 and the host/client split (ADR 0017).
2. **Toolchain** — Node ≥22, pnpm 9.15.0 via Corepack, Rust 1.88 pinned
   (`cargo +1.88.0`), Turbo, Biome (2-space), Vitest, Playwright.
3. **Command crib sheet** — bootstrap/dev/build/test/verify/gates, per-plane
   test one-liners from `CONTRIBUTING.md`, and how to run each plane locally
   (gateway, daemon, control-plane, mock IdP, pages).
4. **Layout map** — condensed table of `apps/*`, `packages/*`, `crates/*`,
   `wit/`, `skills/`, `docs/` with one-line roles (source: `README.md`
   workspace table plus directory inspection).
5. **Design rules that gate merges** — the domain-package import ban, ADR
   0004/0008/0017 constraints, "record consequential decisions as ADRs",
   no-secrets/no-`getSecret()` rules, env-spec configuration pattern.
6. **Security posture** — pointer list: `docs/security/security-boundaries.md`,
   threat models, the `audit-*` series convention, and the gate scripts.
7. **Skills** — one line per skill in `skills/*/SKILL.md` with path.
8. **Verification expectations** — what to run before pushing
   (`pnpm lint && pnpm typecheck && pnpm test`; `pnpm verify` for full).

Create `CLAUDE.md` containing exactly one import line (`@AGENTS.md`) plus a
one-sentence comment that AGENTS.md is the canonical agent context.

Deduplicate the skills trees: keep `skills/` canonical; replace each
`.agents/skills/<name>` directory with a relative symlink to
`../../skills/<name>`.

**Verify:** `diff -r skills .agents/skills` exits 0;
`git ls-files -s .agents/skills` shows mode `120000` entries; every command
quoted in AGENTS.md exists in `package.json`/`CONTRIBUTING.md`/`scripts/`.

## WP2 — Local verification substrate (replaces CI; owns root package.json)

**OWNS:** `.githooks/**`, `scripts/setup-hooks.sh`, root `package.json`,
`CONTRIBUTING.md`

No Actions allowed, so the gate substrate is git hooks + documented commands:

1. `.githooks/pre-commit` (POSIX sh, executable): run
   `pnpm biome check --no-errors-on-unmatched --files-ignore-unknown=true`
   against staged files only, then `bash scripts/gitleaks-gate.sh` if the
   `gitleaks` binary is on PATH (skip with a notice otherwise). Fail fast,
   print remediation hints.
2. `.githooks/pre-push`: honor `OPENSESAME_PREPUSH` env — `off` (skip),
   `fast` (default: `pnpm typecheck && pnpm test`), `full` (`pnpm verify`).
   Print which mode ran and how to change it.
3. `scripts/setup-hooks.sh`: idempotent; `git config core.hooksPath .githooks`
   plus chmod +x; safe to re-run.
4. Root `package.json` edits (exclusive to this package — exact keys):
   - `"setup:hooks": "bash scripts/setup-hooks.sh"`
   - append `&& bash scripts/setup-hooks.sh` to the existing `bootstrap` script
   - `"test:redteam": "pnpm --filter @opensesame/redteam redteam"` (package
     created by WP6)
   - `"test:visual": "pnpm --filter @opensesame/visual-contract test:visual"`
     (package created by WP7)
5. `CONTRIBUTING.md`: add a short "Local gates (no CI)" section — hooks setup,
   `OPENSESAME_PREPUSH` modes, and the statement that this repo intentionally
   runs no GitHub Actions; verification is local plus scheduled agent sessions
   (`docs/operations/agent-routines.md`) and CodeRabbit PR review.

**Verify:** `bash scripts/setup-hooks.sh` twice (idempotent); a commit with a
Biome-dirty staged file is rejected; `OPENSESAME_PREPUSH=off git push --dry-run`
skips; `node -e "JSON.parse(require('fs').readFileSync('package.json'))"`.

## WP3 — Standing agent routines (prompts as code)

**OWNS:** `ops/routines/**`, `security/claude-review-checklist.md`,
`docs/operations/agent-routines.md`

Each routine file is a complete standalone prompt for a scheduled Claude Code
cloud session (fresh session, no memory): state the mission, the exact repo
commands to run, how to interpret results, the deliverable (fix PR with
conventional commits, or a dated report under `docs/security/` following the
existing `audit-YYYY-MM-DD-<topic>.md` naming), and hard rules (no Actions, no
new paid deps, never commit secrets, don't touch Rust unless the finding is in
Rust).

1. `ops/routines/nightly-dependency-triage.md` — run
   `pnpm audit:cve-lite`, `pnpm audit:osv`, `pnpm audit:cargo-audit`,
   `pnpm audit:gitleaks`, `pnpm audit`; triage findings against the existing
   ignore files (`osv-scanner.toml`, `.cargo/audit.toml`, `deny.toml`); open a
   fix PR for actionable advisories, or append a dated note to
   `docs/security/tooling-evaluation.md` for accepted risks.
2. `ops/routines/weekly-security-audit.md` — pick the least-recently-audited
   surface (derive from `docs/security/audit-*.md` filenames), attack it in the
   style of the existing audits (read 3 of them first), write the audit doc,
   and PR minimal fixes.
3. `ops/routines/weekly-docs-drift.md` — cross-check README/PRODUCT/
   CONTRIBUTING/AGENTS.md/docs against the tree (referenced files exist,
   commands run, ports/versions match); PR corrections.
4. `ops/routines/pr-security-review.md` — an on-demand deep-review prompt for a
   PR number: apply `security/claude-review-checklist.md` line by line against
   the diff; post findings as a single review.
5. `security/claude-review-checklist.md` — distill
   `docs/security/security-boundaries.md`, the threat models, and the bug
   classes visible in `docs/security/audit-2026-08-0*.md` into ~20–30 concrete,
   diff-checkable items (listen/bind fences, production fail-closed paths,
   token/proof-key custody, DPoP binding and nonce handling, CSRF fences,
   sealed-store integrity, log redaction, SSRF host parsing, quota bounds).
   Every item cites its source doc.
6. `docs/operations/agent-routines.md` — runbook: how to register each routine
   as a Claude Code cloud scheduled session (cadence, fresh-session mode, paste
   the routine file as the prompt), why this replaces CI-hosted agents (zero
   Actions minutes; subscription-billed), and the interplay with CodeRabbit.

**Verify:** every file/command referenced by the routines exists in the repo;
checklist items each carry a source citation.

## WP4 — Drift fixes + no-Actions amendment

**OWNS:** `scripts/deploy-pages.sh`, `docs/security/tooling-evaluation.md`
(append-only), `docs/ai-automation-roadmap.md` (append-only)

1. `scripts/deploy-pages.sh` (bash, executable, `set -euo pipefail`): build and
   publish `apps/pages` to GitHub Pages **without Actions**: require a clean
   working tree; `pnpm --filter @opensesame/pages build`; honor
   `PAGES_BASE_PATH` (default `/OpenSesame/`) passed to the build as the Vite
   `--base`; publish `apps/pages/dist` to the `gh-pages` branch via a temporary
   `git worktree` (init branch if absent, commit with message
   `deploy(pages): <short-sha>`, push origin); add `.nojekyll`; `--dry-run`
   flag that does everything except push. Print the final URL hint.
2. Append a dated correction note to `docs/security/tooling-evaluation.md`
   under finding 0d: at commit `0608ccc` no `.github/` existed; the repo policy
   is now explicitly **no GitHub Actions** — gates run via local git hooks
   (`scripts/setup-hooks.sh`) and scheduled agent sessions
   (`docs/operations/agent-routines.md`).
3. Append an `## Amendment — no-GitHub-Actions posture (2026-08)` section to
   `docs/ai-automation-roadmap.md`: supersede the P0 "GitHub Actions CI"
   recommendation with the hook substrate + routines; note that Copilot-based
   recommendations are dropped (paid); CodeRabbit remains the PR reviewer;
   promptfoo runs locally or inside scheduled Claude sessions via the
   documented session-auth path.

**Verify:** `bash -n scripts/deploy-pages.sh`; `shellcheck` if available;
`scripts/deploy-pages.sh --dry-run` succeeds after `pnpm install` (build runs,
no push); both docs still render as valid Markdown (no broken headings).

## WP5 — Privacy-bounded telemetry (PostHog, off by default)

**OWNS:** `packages/telemetry/**`, `apps/pages/**`, `apps/mcp-host/**`,
`.env.schema` (append-only)

Free tier + free MIT SDKs only; **everything is a no-op unless a key is
configured**, and the allowlist is enforced in code at the capture site.

1. `packages/telemetry` — `@opensesame/telemetry`, private, tsc build like
   sibling packages. Exports `createTelemetry({ capture })` returning
   `{ track(event, props) }` where:
   - `event` must be in the hardcoded allowlist:
     `app_opened`, `vault_unlocked`, `vault_unlock_failed`, `vault_locked`,
     `item_opened`, `ceremony_queued`, `ceremony_completed`,
     `settings_changed`, `mcp_tool_call`.
   - `props` are filtered to the hardcoded key allowlist:
     `tool`, `client`, `client_version`, `duration_ms`, `outcome`,
     `error_class`, `item_type`, `queue_depth`. Every other key is **dropped**,
     and values are coerced to primitives with a max string length of 64.
   - Unknown event → silently dropped. Include a `redactionTest` export listing
     forbidden key patterns (`token`, `secret`, `authorization`, `cookie`,
     `pepper`, `key`, `pin`, `prompt`, `email`, `sub`) that the filter must
     strip even inside allowed keys' values; unit-test all of this with Vitest.
2. `apps/pages`: add optional `posthog-js` (exact version pin, latest stable);
   init in `src/lib/telemetry.ts` only when `VITE_OPENSESAME_TELEMETRY_KEY`
   (and optional `VITE_OPENSESAME_TELEMETRY_HOST`, default
   `https://us.i.posthog.com`) are present at build time; configure
   `autocapture: false`, `capture_pageview: false`, `disable_session_recording:
   true`, `persistence: 'memory'`. Wire `track()` calls at: app mount
   (`app_opened`), unlock success/failure, lock, item open (`item_type` only —
   never names/ids), ceremony queue/complete, settings save. No identify calls
   — anonymous only.
3. `apps/mcp-host`: add optional `posthog-node`; when
   `OPENSESAME_TELEMETRY_KEY` is set, wrap tool dispatch to emit
   `mcp_tool_call` with `tool`, `duration_ms`, `outcome`
   (`ok`/`error`/`refused`), `error_class` (constructor name only), `client`
   (from MCP handshake clientInfo name/version) — **never arguments, results,
   headers, or session material**. Flush on shutdown. Unit-test the wrapper
   with a stubbed capture.
4. `.env.schema`: append the three variables with env-spec annotations
   (`@public` for host, `@sensitive` for keys; comment: telemetry is opt-in,
   allowlist enforced in `packages/telemetry`, see
   `docs/operators/posthog-setup.md`).

**Verify:** `pnpm --filter @opensesame/telemetry test`,
`pnpm --filter @opensesame/pages test && pnpm --filter @opensesame/pages build`
(without the env vars — must build clean and stay no-op),
`pnpm --filter @opensesame/mcp-host test`.

## WP6 — promptfoo red-team suite for the MCP surfaces

**OWNS:** `packages/redteam/**`

`packages/redteam` — `@opensesame/redteam`, private; devDependency `promptfoo`
(latest stable, pinned). Not part of default `pnpm test` (root wiring is WP2's
`test:redteam`).

1. `promptfooconfig.yaml`: provider `anthropic:messages:claude-sonnet-4-6`
   (or current stable Sonnet id) with `config.apiKeyRequired: false` so an
   authenticated Claude Code session's OAuth credential is used —
   **document in the package README**: run inside a Claude Code session with
   `ANTHROPIC_API_KEY` unset, or export a Console API key to override; never
   commit keys.
2. Test corpus (YAML cases + a small TS harness started with `tsx`): launch
   `apps/mcp-host` as a subprocess (`pnpm --filter @opensesame/mcp-host start`)
   and drive it over stdio with `@modelcontextprotocol/sdk` client. Attack
   classes, ≥4 cases each, derived from the repo's own history (read
   `docs/security/audit-2026-08-08-mcp-agent-boundary.md`,
   `…-mcp-endpoint-fences.md`, `…-mcp-resource-scope.md` first):
   - prompt-injection via tool results / upstream bodies relayed to the model
   - confused-deputy: tool calls attempting to widen resource scope or reach
     endpoints outside the fence
   - credential-exfiltration attempts (asking tools to echo env/config/tokens)
   - malformed/oversized inputs against zod schemas.
   Assertions: refusals/fences hold (promptfoo `contains`/`llm-rubric`
   asserts), no secret-shaped strings in outputs.
3. `package.json` script `"redteam": "promptfoo eval -c promptfooconfig.yaml"`
   plus `"redteam:report": "promptfoo view"`; README covering auth, local run,
   and that the nightly routine (`ops/routines/`) may invoke it.

**Verify:** `pnpm --filter @opensesame/redteam exec promptfoo eval --help`
works; config parses (`promptfoo validate` if available, else a dry parse);
harness typechecks. Model-dependent evals may be skipped in this run if no
session auth is present — the suite must fail gracefully with a clear message
in that case.

## WP7 — Visual contract against `.impeccable`

**OWNS:** `packages/visual-contract/**`

`packages/visual-contract` — `@opensesame/visual-contract`, private;
devDependencies: `@playwright/test` (match root 1.55.1), `pixelmatch`, `pngjs`
(all pinned).

1. Playwright config: build+preview `@opensesame/pages` via `webServer`
   (`pnpm --filter @opensesame/pages preview` on port 5180 after a build), two
   projects: `desktop` 1280×800 and `mobile` 390×844 (mobile emulation).
2. One spec that reproduces the six baseline names exactly
   (`pages-{desktop,mobile}.png` = initial app shell,
   `vault-unlock-{desktop,mobile}.png` = unlock screen,
   `vault-list-{desktop,mobile}.png` = vault list after unlock). Read
   `apps/pages/src/pages/` and `src/App.tsx` to find the real routes and the
   unlock interaction (synthetic/demo data mode — the PWA ships labeled
   synthetic items; drive whatever unlock affordance exists in dev, e.g. the
   PIN flow, via test ids or accessible roles — inspect the components, do not
   guess).
3. Compare each shot to `.impeccable/screenshots/<name>.png` with pixelmatch,
   threshold 0.1, fail over 1.5% differing pixels; write diffs to
   `packages/visual-contract/output/` (gitignored). `--update` mode
   (`VISUAL_UPDATE=1`) rewrites the baselines in place. If current rendering
   legitimately differs from the stale baselines, run update mode once in this
   build-out and commit the regenerated six PNGs (same filenames).
4. Script `"test:visual": "playwright test"`; README: what the contract is
   (design source: `.impeccable/design.json` — navy sidebar, teal accents,
   unlock-first gate), when to update baselines, and the rule that a baseline
   update must be intentional and reviewed.

**Verify:** `pnpm --filter @opensesame/visual-contract test:visual` passes
locally (Playwright browsers: use the preinstalled Chromium if
`PLAYWRIGHT_BROWSERS_PATH` is set; otherwise `playwright install chromium`).

## WP8 — Trust-gated Claude Code session bootstrap

**OWNS:** `.claude/**`

1. `.claude/settings.json`:
   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [ { "type": "command",
             "command": "bash .claude/hooks/session-start.sh" } ] }
       ]
     }
   }
   ```
2. `.claude/hooks/session-start.sh` (executable, POSIX-ish bash): trust-gated
   bootstrap that:
   - exits 0 immediately unless `OPENSESAME_AGENT_BOOTSTRAP=1` **or** the
     session is a remote/ephemeral Claude environment (detect via
     `CLAUDE_CODE_REMOTE`-style env or a container marker; check both, default
     to *not* running);
   - refuses (exit 0 with a warning) if `OPENSESAME_ENV=production` or any of
     `OPENSESAME_CLAIM_PEPPER`/`OPENSESAME_AUTH_SECRET` are set non-empty —
     production credentials must never feed an automated bootstrap;
   - runs `corepack enable && pnpm install --frozen-lockfile`, then
     `pnpm --filter @opensesame/database db:generate` with
     `OPENSESAME_ALLOW_DEV_DEFAULTS=true OPENSESAME_ENV=development`; skips
     migrations (needs Postgres);
   - is idempotent and finishes under ~5 minutes; logs each step.
3. `.claude/README.md` (5–10 lines): what the hook does, the opt-in variable,
   and the security rationale (a repo-controlled hook runs before human review
   of a checkout, so it is inert by default).

**Verify:** `bash -n` both files; run the hook with no env → no-op; with
`OPENSESAME_AGENT_BOOTSTRAP=1` → completes install+generate.

## WP9 — SaaS-side runbooks (Linear, PostHog)

**OWNS:** `docs/operators/linear-workflow.md`, `docs/operators/posthog-setup.md`

Repo work cannot create SaaS resources; write precise operator runbooks:

1. `linear-workflow.md`: create an "OpenSesame" Linear team; seed the backlog
   from the repo's own gap lists — the "Residual" section of
   `docs/testing-evidence.md`, `docs/brief-implementation-status.md`, and
   follow-ups named inside `docs/security/audit-*.md` (tell the operator to
   grep for "follow-up"/"residual"/"tracked"); use Linear's git-branch-name
   convention to tie PRs to issues; delegate issues to the Claude Linear agent
   integration (covered by the existing Claude subscription — **no Copilot**);
   triage rules for auto-delegation.
2. `posthog-setup.md`: create a **dedicated OpenSesame project** (the org's
   existing default project belongs to another product — do not mix); paste-in
   telemetry contract that mirrors `packages/telemetry` exactly (allowed
   events/props enumerated; prohibited: MCP arguments/results, authorization
	   headers, tokens, vault/ceremony content, prompts, user identifiers — <!-- gitleaks:allow -- prose -->
   anonymous only); settings: session replay **off**, autocapture off, US
   region (or chosen region recorded here), retention target, project access
   list; where the env vars go (`.env.schema` names); free-tier note.

**Verify:** every repo path cited exists; the event/prop lists match the
`packages/telemetry` allowlist verbatim (read that package's source — WP5
writes it from the same spec above; if wording differs, the spec in this
prompt is authoritative for both).

---

## Orchestrator: merge & acceptance

1. Spawn WP1–WP9 in parallel (isolated worktrees). Ownership is disjoint by
   construction; the only expected merge friction is `pnpm-lock.yaml`
   (regenerate with `pnpm install` after merging rather than hand-merging).
2. After merging: `pnpm install`, then `pnpm lint:fix && pnpm lint`,
   `pnpm typecheck`, `pnpm test`, `bash scripts/setup-hooks.sh`,
   `scripts/deploy-pages.sh --dry-run`, and each package's verify step that
   wasn't already run.
3. Confirm the hard rules held: `git status --porcelain .github` shows nothing
   (directory must not exist), `git grep -l "copilot" -- ':!docs/ai-automation-roadmap.md'`
   introduces no new hits, no secrets staged (`pnpm audit:gitleaks`).
4. Commit per package (conventional messages) or as one reviewed series, push,
   and open a single PR titled `feat: local-first AI automation build-out
   (agents context, gates, routines, telemetry, red-team, visual contract)`
   whose body lists each work package with its verification result.
