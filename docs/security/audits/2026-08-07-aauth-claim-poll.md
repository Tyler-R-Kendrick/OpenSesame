# Security audit — AAuth helpers + agent claim poll — 2026-08-07

Branch: `chore/audit-tick24`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / clippy / semgrep / battle-test | CLEAN |
| Residual review | Experimental AAuth mappers unauthenticated when enabled; agent claim poll only needed claim id |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | `/experimental/aauth/v1/map/*`, mission/scope open when flag set | Require session or operator bearer |
| Medium | `POST /api/v1/agent-claims/{id}/poll` revealed state with id alone | Require `claim_token` body, verify hash |
| Low | APIs lacked Permissions-Policy | Deny camera/mic/geo/payment/usb on Identity + Host headers |

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway -p opensesame-host-core -- -D warnings
pnpm --filter @opensesame/control-plane test
```
