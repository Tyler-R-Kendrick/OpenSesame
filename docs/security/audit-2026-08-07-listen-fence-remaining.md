# Security audit — remaining listen fences — 2026-08-07

Branch: `chore/audit-tick16`

## Scanners

| Check | Result |
|------|--------|
| semgrep / osv / ast-grep | CLEAN |
| Residual review | Control-plane, callback-edge, mock-idp still unbound by loopback policy |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Identity `OPENSESAME_CONTROL_PLANE_HOST=0.0.0.0` accepted | `assertListenHostAllowed` in `assertSecureConfig` |
| Medium | callback-edge default loopback but no fence | host-core `assert_tcp_listen_allowed` |
| Low | mock-upstream-idp could bind non-loopback | same env override (`OPENSESAME_ALLOW_NONLOCAL=1`) |

## Gate

```bash
pnpm --filter @opensesame/control-plane test
pnpm --filter @opensesame/mock-upstream-idp test
cargo +1.88.0 clippy -p opensesame-callback-edge -- -D warnings
```
