# Security audit — claim verify HTML + API headers — 2026-08-07

Branch: `chore/audit-tick19`

## Scanners

| Check | Result |
|------|--------|
| cargo-audit / gitleaks / cargo-deny | CLEAN |
| Residual review | `/v1/claims/:id/verify` interpolated path into HTML; JSON APIs lacked baseline headers |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Claim verify page echoed `:id` (and claim state) into HTML | `escapeHtml` before interpolation |
| Low | Identity API responses had no nosniff / frame / referrer / HSTS | `apiSecurityHeaders` on all Hono routes; HSTS when `publicUrl` is https |

## Gate

```bash
pnpm --filter @opensesame/control-plane test
```
