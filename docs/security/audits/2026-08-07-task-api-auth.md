# Security audit — Host API task routes require auth — 2026-08-07

Branch: `chore/audit-tick23`

## Scanners

| Check | Result |
|------|--------|
| osv / gitleaks / cargo-deny | CLEAN |
| Residual review | `/api/v1/tasks*` had no session/operator check |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Anyone who could reach Host API could start/list/terminate tasks and freeze intents | `require_session_or_operator` on all task routes; task engine moved into `AppState` |
| Process | CLI / mcp-host called tasks without credentials | Attach `Bearer operator:…` from `OPENSESAME_OPERATOR_TOKEN` (CLI already had helper; mcp-host `hostFetch` now injects) |

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway -p opensesame-cli -- -D warnings
pnpm --filter @opensesame/mcp-host test
```
