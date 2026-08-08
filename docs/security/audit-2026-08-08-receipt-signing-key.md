# Audit tick 49 — ephemeral receipt signing key

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The gateway built its `ReceiptSigner` with `ReceiptSigner::generate()` on every boot, while receipts persist in the database. Every receipt written before a restart therefore verified as `valid: false` at `GET /api/v1/receipts/{id}/verify` — so the non-repudiation record could never be checked, and a genuine receipt was indistinguishable from a forged one. | `ReceiptSigner::from_seed` / `from_seed_b64` load a stable key from `OPENSESAME_RECEIPT_SIGNING_KEY` (base64 32-byte ed25519 seed). Production refuses to start without it; dev still generates one and warns. |
| Medium | `verify_receipt` checked the signature against the signer's own key without looking at `authority_key_id`, so a receipt signed by any other key was reported as a bad signature — tamper evidence for what is actually a key-management problem. | Verification now refuses up front when `authority_key_id` does not match the signer, with a message that names the cause. |

## Notes

- `authority_key_id` was already inside the signed digest, so relabelling a receipt
  has always broken its signature. The gap was purely in how the mismatch was
  reported, and in the key never being stable enough for the check to matter.
- Verification still uses a single current key, so a deliberate key rotation would
  strand older receipts. Serving a verifier registry keyed by `authority_key_id`
  (and publishing the public keys) is the next step and is tracked separately.

## Verification

- `cargo test -p opensesame-audit` — 5 passed (2 new: restart survives, seed parsing)
- `cargo test --workspace` — 0 failures
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- cargo-audit, cargo-deny, osv-scanner, semgrep, gitleaks, cve-lite, ast-grep — clean
