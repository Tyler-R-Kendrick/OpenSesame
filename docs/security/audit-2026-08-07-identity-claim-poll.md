# Security audit — Identity claim get/poll + provider health — 2026-08-07

Branch: `chore/audit-tick25`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / cve-lite / clippy / battle-test / task-access | CLEAN |
| Residual review | Identity `GET /v1/claims/{id}` and `/poll` leaked state by id; `/health/providers` exposed backend errors unauthenticated |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Identity claim get/poll revealed state (and `completedByPrincipalId`) with claim id alone | Require `X-Claim-Token` or `Bearer osc_clm_…`; verify digest; sdk-cli + mcp-client updated |
| Low | Gateway `/health/providers` public with OpenFGA/OpenBao error strings | Require operator bearer; live-stack test uses existing operator header |

## Gate

```bash
pnpm --filter @opensesame/control-plane test
cargo +1.88.0 clippy -p opensesame-gateway -- -D warnings
pnpm --filter @opensesame/mcp-client test
```
