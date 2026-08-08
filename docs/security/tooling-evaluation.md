# Security tooling evaluation

Evaluation of candidate scanners/harnesses for OpenSesame (polyglot Rust/TS, auth dual-plane, Wasm boundary). Goal: find tools we can run locally or in CI without enterprise SaaS, Docker-heavy sandboxes, or large LLM spend — then apply them to this tree.

## Use now

| Tool | Why | How we use it |
|------|-----|----------------|
| **cve-lite** | OSV CVE scan + override hygiene (OA*/PD*) | `pnpm run audit:cve-lite` (`scripts/cve-lite-gate.sh`) |
| **OSV-Scanner** | Google OSV across Cargo + pnpm lockfiles (catches GHSA not yet in RustSec) | `pnpm run audit:osv` (`scripts/osv-scanner-gate.sh`, `osv-scanner.toml`) |
| **cargo-audit** | RustSec advisory scan of `Cargo.lock` (dedicated CLI) | `pnpm run audit:cargo-audit` (`scripts/cargo-audit-gate.sh`) |
| **ast-grep** | Structural SAST for XSS/crypto/injection antipatterns | `pnpm run audit:ast-grep` (`security/ast-grep-rules.yml`) |
| **cargo clippy** | Rust correctness / suspicious patterns (`-D warnings`) | `pnpm run audit:clippy` (matches CI) |
| **gitleaks** | Secret scanning; catches accidental keys in source | `pnpm run audit:gitleaks` (`.gitleaks.toml` prunes `target`/`node_modules`) |
| **cargo-deny** | RustSec advisories, license, source policy | `cargo deny check` + workspace `deny.toml` |
| **pnpm audit** | npm advisory DB for TS apps/packages | `pnpm audit` after dep bumps |
| **Semgrep** | Static rules (`p/rust`, `p/typescript`) on source trees | `pnpm run audit:semgrep` (apps/crates/packages only) |
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

0. **cargo-audit loop (2026-08-07)** — restored missing `scripts/cargo-audit-gate.sh`; `RUSTSEC-2023-0071` (`rsa` via sqlx lockfile edge, no fixed release) ignored in `.cargo/audit.toml` (aligned with `osv-scanner.toml`). sqlx 0.9 / Rust 1.94 upgrade still tracked — see `audit-2026-08-07-cargo-audit.md`.
0c. **clippy/semgrep/ast-grep loop (2026-08-07)** — removed `new Function` crypto fallback in `@opensesame/api-client`; restored `pnpm verify` to Rust 1.88.0 — see `audit-2026-08-07-clippy-semgrep.md`.
0d. **supply-chain / CI loop (2026-08-07)** — gitleaks/osv/cargo-audit/deny/pnpm-audit CLEAN; wired those gates (+ ast-grep, semgrep) into CI `security` job — see `audit-2026-08-07-supply-chain-ci.md`.
0e. **ast-grep after UX (#23)** — extension popup `innerHTML` → `textContent` — see `audit-2026-08-07-ast-grep-popup.md`.
0f. **Pages PWA (#25)** — removed `localStorage` for settings/outbox; OPFS + session-only operator token — see `audit-2026-08-07-pages-localstorage.md`.
0g. **sdk-browser storage** — default `sessionStorage` (not `localStorage`); strip refresh tokens from persisted session — see `audit-2026-08-07-sdk-browser-storage.md`.
0h. **WebAuthn registration** — production passkey enroll requires attestation ceremony + challenge — see `audit-2026-08-07-webauthn-registration.md`.
0i. **credential-agent bind** — legacy agent gets same loopback TCP fence as daemon — see `audit-2026-08-07-credential-agent-bind.md`.
0j. **Pages unlock PIN (#31)** — salted PBKDF2 instead of bare SHA-256 — see `audit-2026-08-07-pages-unlock-pin.md`.
0k. **Pages unlock lockout** — progressive fail lockout after 3 bad PINs — see `audit-2026-08-07-pages-unlock-lockout.md`.
0l. **TOTP stub** — `/v1/mfa/totp/*` gated to `allowDevDefaults` only — see `audit-2026-08-07-totp-dev-only.md`.
0m. **Gateway bind + CORS** — loopback fence on Host API; production CORS fail-closed — see `audit-2026-08-07-gateway-bind-cors.md`.
0n. **Listen fences** — control-plane, callback-edge, mock-idp share `OPENSESAME_ALLOW_NONLOCAL` — see `audit-2026-08-07-listen-fence-remaining.md`.
0o. **Mobile MFA** — real WebAuthn ceremony + session token required — see `audit-2026-08-07-mobile-mfa-webauthn.md`.
0b. **OSV-Scanner loop (2026-08-07)** — `jsonwebtoken` GHSA-h395 type-confusion → `10.4.0` + `aws_lc_rs`; gate at `pnpm run audit:osv` (see `audit-2026-08-07-osv-scanner.md`).
1. **Auth bypass** — `Bearer prn_…` accepted unconditionally → gated behind `OPENSESAME_ALLOW_PRINCIPAL_BEARER`, disabled in production; production requires real claim pepper.
2. **Unauthenticated sync** — gateway `POST /api/v1/sync/push|pull` required session bearer.
3. **gitleaks noise** — connector-host test placeholders renamed off `sk_test_*` / `sk_live_*` patterns.
4. **Dependency CVEs** — bumped `hono`, `drizzle-orm`, `@modelcontextprotocol/sdk`, `react-router-dom`, `@hono/node-server`, workspace `vitest`; pnpm overrides for `shell-quote` / `adm-zip`; `deny.toml` updated for cargo-deny 0.20.
5. **Session expiry** — gateway sync auth now enforces opaque-session `expires_at` and evicts expired entries.
6. **Fail-closed config** — default claim pepper and `prn_` bearer require explicit dev/test mode (`OPENSESAME_ALLOW_DEV_DEFAULTS`, `NODE_ENV`/`OPENSESAME_ENV` development|test, or Vitest); production asserts reject unsafe merges.

Re-run checklist: `pnpm run audit:cve-lite`, `pnpm run audit:osv`, `pnpm run audit:cargo-audit`, `pnpm run audit:ast-grep`, `pnpm run audit:clippy`, `pnpm run audit:gitleaks`, `pnpm run audit:semgrep`, `cargo deny check`, `pnpm audit`, control-plane + connector-host tests, gateway `cargo check`.

## Residual (tracked, not blocking this pass)

- Console Better Auth passkey plugin UI (mobile MFA now uses `/registration-options`).

## Bind policy (daemon / credential-agent)

- Default TCP is loopback-only; non-loopback requires `OPENSESAME_ALLOW_NONLOCAL=1` (legacy alias `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`).
- Locked-down hosts: `OPENSESAME_DAEMON_UDS_ONLY=1` + `OPENSESAME_AGENT_SOCK` (no TCP).
- Legacy `opensesame-credential-agent`, gateway, callback-edge, control-plane, and mock-idp use the same loopback fence.
