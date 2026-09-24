# Security audit — mobile MFA WebAuthn ceremony — 2026-08-07

Branch: `chore/audit-tick17`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / gitleaks / clippy / osv / cve-lite / semgrep | CLEAN |
| Residual review | `@opensesame/mobile-mfa` posted fake passkeys + `Bearer prn_…` |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Mobile MFA register/assert used fabricated credential bytes | Real WebAuthn create/get against `/registration-options` + `/authentication-options` |
| Medium | MFA/device actions used principal-id Bearer fallback | Require session access token |

## Gate

```bash
pnpm --filter @opensesame/mobile-mfa test typecheck
```
