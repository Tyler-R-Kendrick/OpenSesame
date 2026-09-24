# Security audit — supply-chain + CI wiring — 2026-08-07

Branch: `chore/audit-supply-chain`

## Scanners (local)

| Check | Result |
|------|--------|
| `pnpm audit:gitleaks` | CLEAN |
| `pnpm audit:osv` | CLEAN |
| `pnpm audit:cargo-audit` | CLEAN |
| `cargo deny check` | ok (duplicate windows_* warnings only) |
| `pnpm audit --prod` | No known vulnerabilities |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Process | CI ran clippy only; local `pnpm audit:*` gates were not enforced on PRs | Added `security` job in `.github/workflows/ci.yml` (later removed with Actions in #26 — run gates locally via checklist) |

## Residual

- Prefer restoring a CI `security` job if/when Actions return; until then `pnpm audit:*` + `cargo deny check` are local-only.
- `cve-lite` not on npm (private CLI). Keep on the local re-run checklist.
- cargo-deny duplicate `windows_*` crate noise — non-blocking.

## Gate

```bash
pnpm audit:gitleaks && pnpm audit:osv && pnpm audit:cargo-audit && cargo deny check
```
