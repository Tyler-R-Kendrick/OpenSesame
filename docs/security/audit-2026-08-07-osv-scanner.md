# Security audit — OSV-Scanner loop — 2026-08-07

Branch: `feat/task-access-model` (workspace at scan time)

Tool: **Google OSV-Scanner v2.5.0** (`pnpm run audit:osv`). Not used in prior loops (those used gitleaks / cargo-deny / pnpm audit / Semgrep SAST / cve-lite / ast-grep / clippy). Semgrep MCP supply-chain was attempted first but requires a Semgrep daemon unavailable here.

## Scanners

| Check | Result |
|------|--------|
| `osv-scanner scan source` on `Cargo.lock` + `pnpm-lock.yaml` (pre-fix) | 2 vulns |
| `pnpm run audit:osv` (post-fix + `osv-scanner.toml` ignores) | CLEAN |
| `cargo deny check advisories` | ok (did not surface GHSA-h395; not in RustSec DB) |
| `cargo test -p opensesame-proof --lib` | 12 passed |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Moderate (GHSA-h395-gr6q-cpjc / CVE-2026-25537) | `jsonwebtoken@9.3.1` type confusion: malformed `exp`/`nbf` treated like absent → validation bypass | Bump workspace dep to `jsonwebtoken@10.4.0` with `aws_lc_rs` (not `rust_crypto`, which pulls unpatched `rsa`) |
| High (RUSTSEC-2023-0071 / Marvin) | `rsa@0.9.10` timing sidechannel — **no patched release** | Transitive via `sqlx-postgres` only. Documented ignore in `osv-scanner.toml` (OSV may omit it from default results as unimportant/uncalled; keep ignore so a reappearance does not silently reopen the gate). DPoP/JWT uses `aws_lc_rs`, not the `rsa` crate. |

## Follow-ups closed in this loop

1. **DPoP validation config** — `Validation::new(header.alg)` with `validate_exp`/`validate_nbf` off and cleared `required_spec_claims` (proofs use custom `iat` checks).
2. **Gate** — `scripts/osv-scanner-gate.sh` + `pnpm run audit:osv` (auto-downloads pinned binary into `.tools/bin`).
3. **Tooling matrix** — OSV-Scanner added under “Use now” in `tooling-evaluation.md`.

## Residual (tracked)

- Revisit `RUSTSEC-2023-0071` when `sqlx` drops `rsa` or RustCrypto ships a constant-time fix; do not remove the ignore without a lockfile re-check.
- Prefer keeping `jsonwebtoken` on `aws_lc_rs`; switching to `rust_crypto` would reintroduce `rsa` into the JWT path.

## Gate

```bash
pnpm run audit:osv
```
