# opensesame-audit

Signs and verifies invocation receipts for the Host / authority plane. Every
brokered invocation ends in an `InvocationReceipt` (defined in
`opensesame-domain`); this crate signs it with Ed25519 over the canonical JSON
digest and checks that signature later. A receipt names its key by
`authority_key_id`, derived from the public key itself, so the id cannot point
at a key other than the one that checks the signature.

## Where it fits

- **Used by:** [`opensesame-broker`](../broker) (signs the receipt at the end of
  an invoke), [`opensesame-host-core`](../host-core) (re-exported as
  `host_core::audit`), [`apps/gateway`](../../apps/gateway) (`ReceiptSigner` in
  bootstrap, `ReceiptVerifier` in app state), and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`receipt_verify` target).
- **Builds on:** [`opensesame-domain`](../domain) (`InvocationReceipt`,
  `digest_json`) and [`opensesame-redaction`](../redaction) (`redact_event`).
- `sign_receipt` refuses a receipt whose summary fails
  `assert_no_secret_leak()`, and one that fails the domain's schema invariants.
- An unknown key is reported as unknown, not as a bad signature: a rotated or
  ephemeral key is a key-management fact, not tamper evidence.

## Surface

| Item | What it is |
|---|---|
| `ReceiptSigner` | `generate()` (ephemeral — tests and dev only), `from_seed`, `from_seed_b64`, `verifying_key`, `sign_receipt`, `verify_receipt`; public `key_id` |
| `ReceiptVerifier` | Registry of trusted public keys keyed by `authority_key_id`: `trust`, `trust_b64`, `key_ids`, `published_keys`, `verify`. A retired signing key is kept here as its public half, so rotation does not strand old receipts |
| `receipt_key_id(&VerifyingKey)` | `receipt-key:<hex public key>` |
| `redact_event(&Value)` | Thin wrapper over `opensesame_redaction::redact_json` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-audit
pnpm audit:miri      # runs this crate's lib tests under Miri, among others
```

## Related

- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — the
  ConnectionRef → authorize → invoke → receipt path
- [`crates/broker`](../broker) — where receipts are produced
