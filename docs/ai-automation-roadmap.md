# AI subscription & automation roadmap

**Date:** 2026-08-09
**Scope:** How to better use the AI subscriptions and connected services already paid for — across DevEx, security, UX, product analytics, and project management — grounded in the current state of this repo and current agentic-SDLC practice.

## 1. Where we are

This repo is already AI-native in authoring: `.agents/skills/` + `skills/` agent skills, `.cursor/rules`, `.impeccable` design system + screenshots, and a commit history (#92–#106) of agent-driven security fixes backed by ~90 audit documents under `docs/security/`. What is missing is the **automation layer around** that authoring: nothing runs unless a human starts a session.

### Subscription inventory vs. actual usage

| Service | Evidence | Used for this repo today |
|---|---|---|
| Claude (Code + claude.ai) | Commit history, audit docs, this session | Yes — interactive only, no CI/scheduled use |
| GitHub (+ Copilot) | Repo host; Copilot review/agent available | Repo hosting only — **no Actions, no Copilot use** |
| Cursor | `.cursor/rules/no-sudo.mdc` | Minimal (one rule) |
| Linear | Workspace has 3 teams | **No OpenSesame team — unwired** |
| PostHog | Connected project | **Contains another product's events — unwired** |
| Figma | Connector available | Unused; `.impeccable/design.json` is the de-facto design source |
| Supabase | Connector available | Unused (repo uses raw Postgres + Drizzle; keep it that way per ADR 0010) |
| Vercel | Connector available | Unused (ADR 0004 bars Marketplace **auth** for core, not preview hosting) |
| Cloudflare | Connector present, unauthenticated | Unused |
| Context7 / Microsoft Docs | Doc-retrieval MCPs | Ad-hoc |

### Drift found while auditing

Verified at commit `0608ccc` (the base of this branch); reproduce each claim with the command shown.

- `docs/security/tooling-evaluation.md` (finding 0d) says gates were "wired into CI `security` job" — but there is **no `.github/` directory in the repo** (`git ls-files .github` returns nothing). The CI wiring either never landed or was lost.
- `PRODUCT.md` references `scripts/deploy-pages.sh`, which does not exist (`git ls-files scripts/deploy-pages.sh` returns nothing).
- `skills/` and `.agents/skills/` are duplicate trees (`diff -r skills .agents/skills`); there is **no root `CLAUDE.md`/`AGENTS.md`** (`git ls-files CLAUDE.md AGENTS.md` returns nothing) pointing agents at them, so most tools never load them.

## 2. Highest-leverage gaps (priority order)

### P0 — CI as the substrate for everything else

Thirteen gate scripts (`scripts/*-gate.sh`, `battle-test.sh`) plus `pnpm verify` exist and run **only on developer machines**. Every downstream automation (agent PR review, autonomous fix loops, preview deploys) needs CI as its verification oracle — current practice is unambiguous that agent output must land behind CI + human review, not instead of it.

Do:
1. Add `.github/workflows/ci.yml`: typecheck + vitest + cargo test (lib) + clippy, on PR and main. Cache pnpm/cargo; use turbo remote caching if available.
2. Add `security.yml`: the existing `audit:*` gates (gitleaks, osv, cargo-audit/deny, ast-grep, semgrep, cve-lite) — they are already written as CI-shaped pass/fail scripts.
3. Note the `PRODUCT.md` constraint applies to **deploy** ("no custom GitHub Actions runners for deploy"), not to checks.

### P0 — A root `AGENTS.md` / `CLAUDE.md`

The emerging cross-tool standard is a root `AGENTS.md` (adopted by Cursor, Codex, and others; Claude Code reads `CLAUDE.md`). Without it, every session re-derives the port map, the "no Better Auth imports in domain" rule, the Rust 1.88 pin, and which of the 21 apps matter — token-expensive and error-prone.

Do: write one root file (symlink the other name) containing: plane topology + ports, build/test one-liners per plane, design rules from `CONTRIBUTING.md`, ADR index pointer, and pointers into `.agents/skills/*`. Deduplicate `skills/` vs `.agents/skills/`. Add a `session-start-hook` so Claude Code web sessions bootstrap automatically — **trust-gated**: opt-in (or restricted to ephemeral, isolated agent workspaces), `pnpm install --frozen-lockfile` only, and a bootstrap environment that carries no production credentials (dev defaults per `.env.schema`; the hook must never read real peppers, signing keys, or database URLs). A repo-controlled hook runs before a human has reviewed the checkout, so it gets the same scrutiny as CI config.

### P1 — Automate the security-audit loop you already run by hand

The `audit-2026-08-0*` docs show a manual cadence of "run gates → agent reviews a surface → PR". Convert to standing automation on the Claude subscription:

1. **PR-triggered review:** use `anthropics/claude-code-security-review` (pin to a reviewed SHA), which accepts `custom-security-scan-instructions` — point that input at a checked-in checklist file derived from `docs/security/security-boundaries.md` (bind fences, fail-closed prod paths, token custody, DPoP binding). (Alternative: `anthropics/claude-code-action` with the checklist injected via its `prompt` input — it does not accept slash-command-only invocations.) Add a CI smoke step that fails the job if the checklist file is missing or the action cannot resolve it. This encodes the exact bug classes of PRs #92–#106 as a permanent reviewer.
2. **Scheduled deep loops:** Claude Code Routines / scheduled cloud sessions — nightly dependency-advisory triage (cargo-audit/osv output → triaged issue or fix PR), weekly "attack one surface" audit continuing the `docs/security/` series, weekly doc-drift check (the kind that found the two drift items above).
3. **Second-model review diversity:** the GitHub subscription includes Copilot review (`request_copilot_review`) — cheap heterogeneous second opinion on auth-critical diffs; disagreement between reviewers is signal.
4. **Caution (relevant to us specifically):** treat issue/PR text as untrusted input to CI agents — scope the Action's token minimally and keep secrets out of the job env. For fork PRs, `pull_request` gets no repository secrets (so the Claude review simply can't run there), and `pull_request_target` would hand secrets to a workflow adjacent to untrusted code — so use a **two-stage flow**: stage 1 runs only no-secret checks (build, tests, gates) on the fork PR; stage 2, the credentialed Claude review, runs only after explicit maintainer approval (environment approval or a maintainer-applied label), against the immutable head SHA that was approved, with least-privilege permissions and a short-lived credential. Microsoft's 2026 analysis of agent CI secret-exfiltration applies verbatim, and OpenSesame is itself an authority product — dogfood the threat model.

### P1 — Wire Linear as the agent work queue

Create an OpenSesame team in Linear; move the "Residual" lists (`docs/testing-evidence.md`), `docs/brief-implementation-status.md` gaps, and audit-doc follow-ups into issues. Then use agent delegation, matching each agent's native queue: Claude takes work directly from Linear via the Linear agent integration; Copilot only takes GitHub issues (`assign_copilot_to_issue` requires `owner`/`repo`/`issue_number`), so enable Linear's GitHub Issues sync (or an equivalent one-way mirror) and keep the Linear issue canonical — delegate to Copilot against the mirrored GitHub issue number. Either path gives an auditable **intent → agent → PR → review** pipeline instead of chat-session archaeology, and Linear's git-branch-name convention ties each PR to its issue automatically.

### P2 — PostHog: product + MCP analytics (currently pointed at the wrong product)

The connected project carries QuickDeployAI events. Create a dedicated OpenSesame project, then:

- **Client surfaces** (`apps/pages` PWA, console, extension): pageviews, web vitals, error tracking, funnels on the unlock → search → item ceremony path. The PWA's privacy posture is compatible with self-limiting capture (no autocapture of vault content; capture ceremony outcomes, not payloads).
- **MCP servers** (`apps/mcp-host`, `apps/mcp-client`): PostHog now has first-class MCP analytics (`$mcp_tool_call`, `$mcp_initialize`, tool failure/latency breakdowns). Instrumenting our own MCP servers tells us which tools agents actually call, failure rates per harness, and where agents report missing capabilities — direct product feedback from agent users, which **is** our target market.
- **LLM analytics** (`$ai_generation`/`$ai_trace`) if/when the credential-agent or example agents call models.
- **Telemetry contract (decide before creating the project):** an explicit property **allowlist** — tool name, client/harness name+version, duration, outcome, coarse error class, and coarse geo at most. Explicitly prohibited from ever reaching PostHog: MCP tool arguments and results, authorization headers or tokens, vault/ceremony content, prompts, and user identifiers (pairwise-pseudonymous IDs only, consistent with ADR 0011). Align the instrumentation with the connector SDK and `skills/opensesame-mcps` guidance so the allowlist is enforced at the capture call site, not by convention. Fix retention, hosting region, project access, and a no-session-replay-on-vault-surfaces rule up front.

### P2 — Evals and red-teaming for the agent-facing surfaces

`tooling-evaluation.md` already shortlists promptfoo as "adopt later" — the blocker (needs eval suites + keys) is now largely met, with one caveat: a Claude Code/claude.ai plan is interactive usage, **not** Anthropic Console API access, and promptfoo needs model access one of two ways. Either (a) an Anthropic Console API key with its own prepaid budget, stored in the CI secret store, or (b) promptfoo's Claude Code session path (`apiKeyRequired: false` on the `anthropic:` provider, `ANTHROPIC_API_KEY` unset), which reuses the subscription's OAuth credential and therefore requires running inside an authenticated Claude Code session — a natural fit for the scheduled Routine. Pick one and document it in the suite. Stand up a small promptfoo suite red-teaming `mcp-host`/`mcp-client` for prompt-injection and confused-deputy behavior (upstream body relaying was already a real bug — #102), run it in the nightly Routine. This is the same "adversarial verification" pattern used in multi-agent review: generators propose attacks, a judge verifies refusals.

### P3 — UX loop: Impeccable + Playwright + Figma + previews

- `.impeccable/design.json` + screenshots are a design contract with no enforcement. Add a Playwright visual pass that regenerates the six screenshots per PR and lets an agent (screenshot-capable Claude review) diff against the contract — "Unlock Honesty Rule" and layout rules become reviewable.
- Vercel free/hobby previews for `apps/pages`/console give reviewers a clickable per-PR build without violating the GitHub Pages deploy constraint (ADR 0004 only bars Vercel Marketplace *auth* in core).
- Figma: import `design.json` tokens so design exploration happens against the real palette; low priority until UI churn resumes.

### P3 — Docs & DX retrieval

- Publish the generated OpenAPI (`apps/control-plane/openapi.json`) and WIT contracts to a docs site; submit the TS SDK to Context7 indexing so external agents integrating against OpenSesame get correct usage — dogfooding the "agents as users" positioning.
- Keep Context7/Microsoft Docs MCPs in the default toolset for sessions touching Better Auth, oidc-provider, or WebAuthn — they change faster than model training data.

## 3. Sequenced plan

| When | Action | Subscription used |
|---|---|---|
| Week 1 | CI + security workflows; root `AGENTS.md`/`CLAUDE.md`; dedupe skills; session-start hook | GitHub, Claude |
| Week 2 | Claude PR review action w/ security checklist; Copilot second review on auth paths | Claude, GitHub Copilot |
| Week 3 | Nightly advisory-triage Routine; weekly audit-loop Routine; Linear team + backlog import + agent delegation | Claude, Linear |
| Month 2 | OpenSesame PostHog project: pages/console analytics + error tracking; MCP server instrumentation | PostHog |
| Month 2 | promptfoo red-team suite for MCP surfaces in nightly Routine | Claude |
| Month 3 | Playwright visual contract vs `.impeccable`; Vercel PR previews; OpenAPI docs site + Context7 indexing | Vercel, Figma, Claude |

Cloudflare's connector is unauthenticated in agent sessions; authorize it via claude.ai connector settings if the callback-edge/Workers path becomes real, otherwise drop it from the session toolset.

## 4. Patterns this plan borrows (state of the art, mid-2026)

- **Hybrid loop:** plan interactively, execute in sandboxed agents, merge only behind CI + human review ([Sourcegraph](https://sourcegraph.com/blog/agentic-coding), [Kilo](https://kilo.ai/articles/beyond-autocomplete)).
- **Spec/context engineering over prompting:** persistent repo-level context files (`AGENTS.md`) and specs (this repo's ADRs are already that — point agents at them) ([futureproofing.dev](https://www.futureproofing.dev/resources/ai-native-team/agentic-coding-workflow-2026)).
- **Standing autonomous agents:** scheduled Routines for maintenance/audit loops rather than one-off sessions ([Claude Code Routines](https://www.claudedirectory.org/blog/claude-code-routines-guide), [docs](https://code.claude.com/docs/en/github-actions)).
- **Role-split multi-agent review** with adversarial verification of findings ([TeamDay](https://www.teamday.ai/blog/complete-guide-agentic-coding-2026)).
- **Agent-CI hardening:** minimal tokens, untrusted-content isolation in agent workflows ([Microsoft Security Blog](https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/), [claude-code-action](https://github.com/anthropics/claude-code-action)).
