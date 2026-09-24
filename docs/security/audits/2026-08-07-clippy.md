# Security audit — cargo clippy loop — 2026-08-07

Branch: `chore/security-clippy-loop`

Tool: **cargo clippy** (`--workspace --all-targets -- -D warnings`, same as CI). Not used as a repair-loop driver in prior passes (gitleaks, cargo-deny, pnpm audit, Semgrep, cve-lite, ast-grep).

## Scanners

| Check | Result |
|------|--------|
| `pnpm run audit:clippy` / `scripts/clippy-gate.sh` | CLEAN |
| `cargo clippy --workspace --all-targets -- -D warnings` | CLEAN |

## Findings fixed

| Lint | Location | Fix |
|------|----------|-----|
| `too_many_arguments` | `PlaceholderPlacement::assert_allowed` | Introduced `PlaceholderRequestView` |
| `too_many_arguments` | `substitute_placeholder` | Introduced `SubstitutePlaceholderRequest` |
| `too_many_arguments` | broker `finish_receipt` | Introduced `FinishReceiptParts` |
| `uninlined_format_args` | invocation / openbao | Inlined format args |
| `collapsible_if` / `bool_comparison` | authz | Collapsed conditions / `!flag` |
| `result_map_or_else` | openbao health | `map_err` |
| `derivable_impls` | `WasmGuestPolicy` | `#[derive(Default)]` |
| `mixed_attributes` | opensesame-core | Removed conflicting module docs |
| `single_match` | CLI daemon install | `if let` / `is_ok()` |
| `result_large_err` | gateway/daemon auth helpers | Crate-level allow (axum `Response` Err) |

## Gate

```bash
pnpm run audit:clippy
```
