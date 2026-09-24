# Security audit — Pages vault unlock PIN — 2026-08-07

Branch: `chore/audit-tick12` (post `#31` authority vault)

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / gitleaks | CLEAN |
| Manual review of `#31` unlock | Unsalted SHA-256 of short PIN in OPFS |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Unlock PIN stored as bare SHA-256 (no salt/KDF; 4-char minimum) | Salted PBKDF2-SHA-256 (210k iters), min 6 chars, timing-safe compare; auto-upgrade legacy digests |

## Gate

```bash
pnpm --filter @opensesame/pages test
```
