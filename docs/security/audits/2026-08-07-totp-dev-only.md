# Security audit — stub TOTP gated for production — 2026-08-07

Branch: `chore/audit-tick14`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / clippy / semgrep / osv / task-access | CLEAN |
| Residual review | `/v1/mfa/totp/*` labeled DEV but available whenever `allowDevDefaults` was false |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | In-memory stub TOTP enroll/verify usable outside allowDevDefaults | Return 403 `totp_dev_only`; prefer passkeys for production MFA |

## Gate

```bash
pnpm --filter @opensesame/control-plane test
```
