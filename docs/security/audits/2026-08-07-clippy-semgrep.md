# Security audit — clippy / semgrep / ast-grep loop — 2026-08-07

Branch: `chore/audit-clippy-semgrep`

## Scanners

| Check | Result |
|------|--------|
| `pnpm audit:clippy` | CLEAN |
| `pnpm audit:semgrep` | CLEAN |
| `pnpm audit:cve-lite` | CLEAN |
| `pnpm test:task-access` | OK |
| `./scripts/battle-test.sh` | ALL PASSED |
| `pnpm audit:ast-grep` (pre-fix) | FAIL — `ts-eval` on `new Function` in api-client |
| `pnpm audit:ast-grep` (post-fix) | CLEAN |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | `new Function(... import('node:crypto'))` in `@opensesame/api-client` DPoP helper | Use `globalThis.crypto.subtle` only (Node 19+ / browsers); fail closed if missing |
| Process | `pnpm verify` pinned `cargo +1.94.0` while `rust-toolchain.toml` / scripts use `1.88.0` (slipped into #18) | Restore `+1.88.0` |

## Gate

```bash
pnpm audit:clippy && pnpm audit:semgrep && pnpm audit:ast-grep
```
