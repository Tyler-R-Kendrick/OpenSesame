# Security audit — device code storage + approval fence — 2026-08-08

Branch: `chore/audit-tick27`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / pnpm audit | CLEAN |
| task-security-battle-test / battle-test | CLEAN |
| Residual review | Host API device flow held `device_code` / `user_code` in cleartext and compared codes with `==` |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Pending device grants stored the device code as a cleartext map key and the user code verbatim, so a memory/state disclosure yielded usable bearers | Key the pending map by `hash_secret(device_code)`; store `user_code_hash` only (matches claim sessions) |
| Medium | `POST /api/v1/device/approve` compared user codes with `==` and allowed unlimited guesses per pending grant | Constant-time `hash_eq`; misses increment `approve_attempts` and codes are burned after 5 |

Device codes remain UUID-derived (high entropy); the user code (~35 bits) is the
credential the attempt cap protects.

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway --all-targets -- -D warnings
cargo +1.88.0 test -p opensesame-gateway --bins
./scripts/battle-test.sh
```
