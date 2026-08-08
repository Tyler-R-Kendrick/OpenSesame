# Security audit — sync store quotas — 2026-08-08

Branch: `chore/audit-tick28`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / ast-grep / clippy / semgrep | CLEAN |
| gitleaks working tree | CLEAN |
| gitleaks git history | 5 findings, all on unmerged `feat/pages-vault-redesign` (fixture/sample strings and a `PREFS_KEY` storage-key name) — not on `main`; owner branch to rename or allowlist before merge |
| Residual review | E2EE sync store had only a global blob ceiling |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | One authenticated session could push up to the global 4096-blob ceiling, starving every other tenant, with no per-blob size limit | Per-session ceiling (512) and per-blob ciphertext ceiling (256 KiB); response reports both plus rejection counters |
| Low | `device_cursors` was keyed by unbounded client-supplied `device_id`, so an authenticated session could grow the map without limit | Cap device id length (128) and cursor table size (4096); new devices only tracked while under the ceiling |

Admission logic extracted into a pure `push_outcome` so quota, ownership, and
stale-epoch behavior are unit-tested (foreign owner still cannot overwrite, and
updates to already-owned blobs stay allowed at quota).

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway --all-targets -- -D warnings
cargo +1.88.0 test -p opensesame-gateway --bins
```
