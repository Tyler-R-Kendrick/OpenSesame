# Security audit — provisional session id is not a credential — 2026-08-07

Branch: `chore/audit-tick18`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / osv | CLEAN |
| Residual review | Cookie + token map treated `ps_…` session ids as authenticators |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | `provisionalTokens` aliased session id → session; cookie fallback used the raw session id | Auth accepts only `pst_…` access tokens; stop storing session id as a token |

## Gate

```bash
pnpm --filter @opensesame/control-plane test
```
