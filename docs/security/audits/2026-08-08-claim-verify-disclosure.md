# Security audit — claim verification page disclosure — 2026-08-08

Branch: `chore/audit-tick26`

## Scanners

| Check | Result |
|------|--------|
| gitleaks (tree + history) | CLEAN |
| osv-scanner / cargo-audit / cargo-deny | CLEAN |
| Residual review | `/v1/claims/:id/verify` still disclosed claim state by URL alone after #46 |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Low | Verification landing page revealed claim existence + state (`pending`/`completed`/`denied`) to anyone with the URL | Page no longer loads the session; renders neutral console hand-off. Test asserts no state string leaks |

Daemon `/v1/*` handlers re-checked: every mutation and read (`list_sessions`, `mint_capability`,
`introspect_capability`, `revoke`, toolbar endpoints) requires the operator token.

## Gate

```bash
pnpm --filter @opensesame/control-plane test
pnpm --filter @opensesame/control-plane typecheck
```
