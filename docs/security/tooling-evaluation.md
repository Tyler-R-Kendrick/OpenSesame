# Security tooling evaluation

Evaluation of candidate scanners/harnesses for OpenSesame (polyglot Rust/TS, auth dual-plane, Wasm boundary). Goal: find tools we can run locally or in CI without enterprise SaaS, Docker-heavy sandboxes, or large LLM spend — then apply them to this tree.

## Use now

| Tool | Why | How we use it |
|------|-----|----------------|
| **gitleaks** | Secret scanning; catches accidental keys in source | `gitleaks detect --source . --no-git` (ignore `.tools/`) |
| **cargo-deny** | RustSec advisories, license, source policy | `cargo deny check` + workspace `deny.toml` |
| **pnpm audit** | npm advisory DB for TS apps/packages | `pnpm audit` after dep bumps |
| **Semgrep** | Static rules (`p/rust`, `p/typescript`) on auth paths | Focused scans of control-plane / gateway |
| **Manual auth-path review** | Catches design bugs scanners miss | Bearer bypass, unauthenticated sync, prod fail-closed |

## Adopt later (CI / when credentials exist)

| Tool | Fit | Blocker today |
|------|-----|----------------|
| [claude-code-security-review](https://github.com/anthropics/claude-code-security-review) | PR review agent | Needs Anthropic API + GitHub Action wiring |
| [codex-security](https://github.com/openai/codex-security) | Agent security review | Needs OpenAI / Codex CI |
| [deepsec](https://github.com/vercel-labs/deepsec) | Vercel/Next-oriented deep scan | Better once we have a Vercel-deployed surface |
| [promptfoo](https://github.com/promptfoo/promptfoo) | LLM red-team / prompt injection | Valuable for MCP/agent surfaces; needs eval suites + model keys |
| [SkillSpector](https://github.com/NVIDIA/SkillSpector) | Skill/tool-call security | Relevant when we ship agent skills at scale |
| Semgrep CI + custom rules | Continuous SAST | Wire after baseline is clean |

## Skip / not a fit (for this repo right now)

| Tool | Reason |
|------|--------|
| [fickling](https://github.com/trailofbits/fickling) | Pickle malware analysis — we do not load untrusted pickle |
| [IRIS](https://github.com/iris-sast/iris) | Heavy academic SAST stack; high setup cost vs Semgrep |
| [PyRIT](https://github.com/microsoft/PyRIT) | GenAI red team — overkill until prompt/agent eval harness exists |
| [PurpleLlama](https://github.com/meta-llama/PurpleLlama) / [Prompt-Guard-86M](https://huggingface.co/meta-llama/Prompt-Guard-86M) | Model-side prompt classifiers; host later at MCP ingress |
| [little-canary](https://github.com/hermes-labs-ai/little-canary) | Canary/honeytoken product — ops tooling, not code SAST |
| [defending-code-reference-harness](https://github.com/anthropics/defending-code-reference-harness) | Needs Docker/gVisor-style sandbox |
| [visa-vulnerability-agentic-harness](https://github.com/visa/visa-vulnerability-agentic-harness) | Research harness; not day-to-day scanner |
| MAI Cyber / MDASH / Microsoft Exposure Mgmt AI code security | Enterprise Microsoft Security products |
| OWASP scanner catalog / awesome-threat-intel / YARA rules | Reference lists — useful for ops/malware, not first-pass app SAST |
| Claude Code security docs | Guidance for Claude product; principles already applied via review |

## Findings applied from this pass

1. **Auth bypass** — `Bearer prn_…` accepted unconditionally → gated behind `OPENSESAME_ALLOW_PRINCIPAL_BEARER`, disabled in production; production requires real claim pepper.
2. **Unauthenticated sync** — gateway `POST /api/v1/sync/push|pull` required session bearer.
3. **gitleaks noise** — connector-host test placeholders renamed off `sk_test_*` / `sk_live_*` patterns.
4. **Dependency CVEs** — bumped `hono`, `drizzle-orm`, `@modelcontextprotocol/sdk`, `react-router-dom`, `@hono/node-server`, workspace `vitest`; pnpm overrides for `shell-quote` / `adm-zip`; `deny.toml` updated for cargo-deny 0.20.
5. **Session expiry** — gateway sync auth now enforces opaque-session `expires_at` and evicts expired entries.
6. **Fail-closed config** — default claim pepper and `prn_` bearer require explicit dev/test mode (`OPENSESAME_ALLOW_DEV_DEFAULTS`, `NODE_ENV`/`OPENSESAME_ENV` development|test, or Vitest); production asserts reject unsafe merges.

Re-run checklist: `gitleaks detect --source . --no-git --config .gitleaks.toml`, `cargo deny check`, `pnpm audit`, control-plane + connector-host tests, gateway `cargo check`.

## Residual (tracked, not blocking this pass)

- **react-router** 7.18.x still has one high (RSC CSRF; patched in ≥8.3). Console stays on v7 for now — major bump deferred.
- Global gateway `sync_blobs` is session-gated but not yet tenant-scoped (pre-existing design debt).
