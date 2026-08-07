# Security audit — Pages PWA localStorage — 2026-08-07

Branch: `chore/audit-tick8` (post `#25` Pages shell)

## Scanners

| Check | Result |
|------|--------|
| `pnpm audit:ast-grep` (pre-fix) | FAIL — `ts-localstorage-set` in `settings.ts` / `queue.ts` |
| `pnpm audit:ast-grep` (post-fix) | CLEAN |
| semgrep / gitleaks / cve-lite / osv / cargo-audit | CLEAN |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Operator token + claim/user-code outbox in `localStorage` | OPFS + memory KV; operator token session-only (not persisted) |
| Medium | Offline queue in `localStorage` | Same KV path as settings URLs |

## Gate

```bash
pnpm audit:ast-grep
pnpm --filter @opensesame/pages typecheck test
```
