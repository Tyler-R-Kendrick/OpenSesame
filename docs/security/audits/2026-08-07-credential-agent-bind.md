# Security audit — credential-agent bind fence — 2026-08-07

Branch: `chore/audit-tick11`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / clippy / gitleaks / osv / cve-lite | CLEAN |
| Residual review | Legacy `credential-agent` bound TCP without daemon loopback fence |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Deprecated credential-agent could bind non-loopback TCP | Apply `assert_tcp_listen_allowed` (same as daemon) |
| Docs | supply-chain CI note still claimed live Actions security job | Note removal in #26 |

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-credential-agent -- -D warnings
pnpm audit:ast-grep
```
