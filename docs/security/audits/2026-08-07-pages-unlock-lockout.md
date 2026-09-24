# Security audit — Pages unlock lockout — 2026-08-07

Branch: `chore/audit-tick13`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / gitleaks / osv / cve-lite / cargo-audit / deny | CLEAN |
| Follow-up on PIN hardening (#32) | No attempt throttle — interactive guessing still easy |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Unlock PIN had no fail lockout | Progressive lockout after 3 fails (2s…15m), persisted via OPFS KV |

## Gate

```bash
pnpm --filter @opensesame/pages test
```
