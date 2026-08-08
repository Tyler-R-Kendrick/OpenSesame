# Audit tick 42 — agent-claim consent proof, receipt error text

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, ast-grep, clippy, semgrep, gitleaks, osv-scanner, cargo-deny, task-security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `POST /api/v1/agent-claims/{id}/complete` (Host API) minted a `user_code` at claim creation but never checked it. An operator token plus the claim token — both of which a co-resident process on the machine can hold — completed any pending claim, binding an agent instance to the bootstrap principal with no proof the human was looking at the device that asked to be claimed. | Require `user_code` in the body, compare it against `user_code_hash` with the constant-time `hash_eq`, and refuse the claim after five wrong codes. |
| Medium | Broker failure receipts stored the connector error verbatim (`json!({"error": e.to_string()})`). Receipts are durable and readable through `GET /v1/receipts/{id}`, so an upstream error carrying a URL with userinfo, a header echo, or a DSN was persisted in cleartext. | Pass the message through `opensesame_redaction::redact_text` before it reaches `safe_result_summary`. |
| Low | `assert!(receipt.assert_no_secret_leak())` panicked the request task — and the leak check only scans for secret *labels*, so a bare token value passes it anyway. A panic here is a 500 plus a poisoned span rather than a controlled denial. | Return an error (`anyhow::bail!`) so the invocation fails closed without unwinding through the handler. |

## Notes

- The gate is a pure `complete_gate(session, claim_token, user_code, attempts)` function, unit-tested for
  the wrong-code, wrong-token, no-code, and locked paths, so the ordering (claim token before user code,
  lock before either) cannot drift.
- The per-claim attempt counter is pruned alongside expired claim sessions in `create_identity`, so it
  cannot outgrow the claim map.
- `apps/daemon` now requires `user_code` for both approval paths (Host API agent-claim and the Identity API
  fallback) instead of only the fallback.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean
- gitleaks, osv-scanner, cargo-deny, cargo-audit, cve-lite, ast-grep, semgrep — clean
- `pnpm run test:task-access` — clean
