# Security audit — Host API CORS + security headers — 2026-08-07

Branch: `chore/audit-tick20`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / osv | CLEAN |
| Residual review | Browser console/PWA call Host API (`:8787`) and daemon (`:18790`) with no CORS; no nosniff/frame headers |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Host API had no CORS; Vite apps on `:5173+` cannot use `fetch` against `:8787` | Shared `OPENSESAME_CORS_ORIGINS` allowlist (`*`/`null` rejected; production requires explicit list) |
| Low | Gateway/daemon/callback-edge/credential-agent lacked baseline security headers | `apply_http_security` / `apply_security_headers` in host-core (HSTS when resource/host API is https) |

## Gate

```bash
cargo +1.88.0 test -p opensesame-host-core --lib
cargo +1.88.0 clippy -p opensesame-gateway -p opensesame-daemon -p opensesame-callback-edge -p opensesame-credential-agent -- -D warnings
```
