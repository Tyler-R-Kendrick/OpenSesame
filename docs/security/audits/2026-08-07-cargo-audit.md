# Security audit — cargo-audit loop — 2026-08-07

Branch: `chore/audit-cargo-audit-gate`

Tool: **cargo-audit** (RustSec) via `pnpm run audit:cargo-audit` / `scripts/cargo-audit-gate.sh`.

## Scanners

| Check | Result |
|------|--------|
| `pnpm run audit:cargo-audit` (pre-fix; missing gate script) | FAIL (script absent; package.json already pointed at it) |
| `cargo +1.88.0 audit` (raw, no ignore) | FAIL — `RUSTSEC-2023-0071` (`rsa@0.9.10`) |
| `pnpm run audit:cargo-audit` (post-fix + `.cargo/audit.toml`) | CLEAN |
| `cargo deny check advisories` | ok |

## Findings

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium (RUSTSEC-2023-0071) | Marvin Attack timing sidechannel in `rsa@0.9.10` — **no patched release** | Documented ignore in `.cargo/audit.toml` (same advisory already ignored in `osv-scanner.toml`). Not on JWT/DPoP path (`aws_lc_rs`). |
| Process | `audit:cargo-audit` npm script existed without `scripts/cargo-audit-gate.sh` | Added gate script (toolchain default `1.88.0` matching `rust-toolchain.toml`) |

## Residual (tracked)

- Revisit ignore when `sqlx` drops `rsa` or RustCrypto ships a constant-time fix. sqlx 0.9 requires Rust ≥ 1.94; workspace stays on 1.88.0 for now.
- Do not remove the ignore without a lockfile re-check.

## Gate

```bash
pnpm run audit:cargo-audit
```
