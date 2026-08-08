# Security audit — gateway bind + production CORS — 2026-08-07

Branch: `chore/audit-tick15`

## Scanners

| Check | Result |
|------|--------|
| gitleaks / cve-lite / cargo-audit / ast-grep / battle-test | CLEAN |
| Residual review | Gateway TCP lacked daemon-style loopback fence; production CORS allowlist not asserted |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Gateway could bind `0.0.0.0` via `OPENSESAME_LISTEN` without override | `assert_tcp_listen_allowed` on gateway; shared `OPENSESAME_ALLOW_NONLOCAL=1` (daemon alias kept) |
| Medium | Production `assertSecureConfig` did not reject empty/`*` CORS | Fail closed on empty, `*`, or `null` origins when `isProduction` |

## Gate

```bash
cargo +1.88.0 test -p opensesame-host-core --lib
pnpm --filter @opensesame/control-plane test
```
