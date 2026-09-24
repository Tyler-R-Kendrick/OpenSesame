# Security audit — sdk-browser storage default — 2026-08-07

Branch: `chore/audit-tick9`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / clippy / semgrep / gitleaks / task-access | CLEAN (no literal `localStorage.setItem`) |
| Manual review | `@opensesame/sdk-browser` defaulted to `localStorage` via `StorageLike` indirection |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Default browser SDK persisted access/refresh tokens in `localStorage` | Default to `sessionStorage`; never write `refresh_token` to storage |

## Gate

```bash
pnpm --filter @opensesame/sdk-browser test
```
