# Audit tick 44 — the deprecated credential agent was an unauthenticated daemon

Date: 2026-08-08
Scanners: cargo-audit, osv-scanner, ast-grep, cve-lite, clippy, semgrep, gitleaks, cargo-deny, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `apps/credential-agent` — marked deprecated, still built and documented — served `/v1/list_sessions`, `/v1/mint_capability`, `/v1/introspect_capability`, and `/v1/revoke` with no authentication at all. The daemon that replaced it fences the same routes behind an operator bearer, so any co-resident process could skip the daemon, enumerate host sessions and their principals, mint itself a 30-minute session capability, or revoke someone else's. Loopback is not a boundary in this threat model — it is why the daemon has an operator token and a UDS-only mode. | Every `/v1/*` route now requires the operator bearer, and the process refuses to start unless `OPENSESAME_LEGACY_CREDENTIAL_AGENT=1` is set, so a stray build cannot quietly offer a second privileged local API. |
| Medium | The capability map grew without bound and never dropped expired entries, so an unauthenticated mint loop was also a memory sink. | Prune on mint and cap at 1024 live capabilities. |
| Low | `constant_time_eq` and the operator header parsing were copied per binary, so a fix in one did not reach the others. | Moved to `opensesame_host_core::operator` (`check`, `token_from_headers`, `constant_time_eq`) with unit tests; the daemon now uses it. |

## Notes

- `check` returns `Unconfigured` distinctly from `Unauthorized`: an unset token must
  deny (503) rather than compare against an empty secret and let everything through.
- Follow-up from tick 43 closed: `opensesame intent invoke --digest …` spends a frozen
  intent through the fenced Host API route, so the CLI can drive the whole freeze →
  execute path.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean (new `host_core::operator` tests)
- semgrep, gitleaks, cargo-audit, osv-scanner, cargo-deny, cve-lite, ast-grep — clean
- `pnpm run test:task-access`, `pnpm run test:security` — clean
