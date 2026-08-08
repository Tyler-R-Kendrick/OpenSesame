# Security audit — SPA CSP + mock-idp headers — 2026-08-07

Branch: `chore/audit-tick21`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / clippy / gitleaks | CLEAN |
| Residual review | Vite SPAs had no CSP; mock upstream IdP JSON lacked nosniff/frame headers |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Console / Pages / PWA / MFA / example RPs / extension popup allowed any script/style | Meta CSP: `script-src 'self'`, fonts.googleapis + gstatic, `connect-src` http/https/ws for local APIs + Vite HMR |
| Low | Mock IdP responses had only `cache-control` | nosniff / DENY frame / no-referrer; HSTS when issuer is https |

## Gate

```bash
pnpm --filter @opensesame/mock-upstream-idp test
```
