# Audit tick 50 — receipt verification keyed by authority, and published

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

Follows tick 49, which made the receipt signing key stable but left verification
trusting exactly one key.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `GET /api/v1/receipts/{id}/verify` checked every receipt against the single active signing key, so rotating the key stranded every receipt the previous one signed — the only way to keep old receipts verifiable was never to rotate. Worse, keeping them verifiable meant keeping the old *seed*, so rotation could not actually retire secret material. | A `ReceiptVerifier` registry maps `authority_key_id` to a trusted public key. Retired keys are supplied as public halves via `OPENSESAME_RECEIPT_VERIFY_KEYS`, so the old seed can be destroyed while its receipts stay verifiable. |
| Medium | The receipt public keys were never published, so verification existed only as the gateway's own assertion — a receipt could not be checked by the party holding it, which is the point of a signed receipt. | `GET /api/v1/receipts/keys` publishes the accepted key ids with their ed25519 public keys. A holder can rebuild the verifier from that material alone (covered by test). |

## Notes

- `authority_key_id` is derived from the public key (`receipt-key:<hex>`), so a
  receipt cannot name a key other than the one that will check its signature, and
  the registry lookup cannot be steered by the receipt.
- An unknown key is reported as unknown rather than as a bad signature: a rotated
  or ephemeral key is a key-management fact, not tamper evidence. Tampering under a
  trusted key still fails the signature check.
- The keys endpoint is deliberately unauthenticated — it serves public material and
  independent verifiability is the goal.

## Verification

- `cargo test -p opensesame-audit` — 8 passed (3 new: retired key still verifies,
  published keys round-trip, empty verifier trusts nothing)
- `cargo test --workspace` — 0 failures
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- cargo-audit, cargo-deny, osv-scanner, semgrep, gitleaks, cve-lite, ast-grep — clean
