# Audit 2026-08-08 — a stored nonce could panic the vault client

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy,
task-security-battle-test — all clean. This came from reading
`crates/human-vault`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `decrypt_item` and `unwrap_vrk_with_password` passed a base64-decoded nonce straight to `XNonce::from_slice`, which panics on any length but 24. Both nonces arrive inside a record this crate explicitly does not trust — the module header says the server stores ciphertext and the KDF band comment says wrapper fields are untrusted input — so a corrupt or hostile envelope crashed the client instead of failing to decrypt. In the wasm build that is a trap that takes the vault session with it. | `decode_nonce` refuses any other length with a new `NonceLength` error. |
| Low | `wrap_vrk_with_password` left both the Argon2 output and the derived KEK in its frame. The unwrap path already zeroized both. | Wrap now zeroizes both, matching unwrap. |

The panic was reproduced before the fix: a five-byte nonce asserted `left: 5, right: 24` inside `GenericArray::from_slice`.

This is the same class the crate had already thought about one line lower —
"authentic but wrong-sized material must be an error, not a panic on
`copy_from_slice`" guards the unwrapped key length. The nonce was the one length
still taken on faith.

## Checked and clean

`crates/client-core` uses `XNonce::from_slice` twice on the same primitive. Its
`open` rejects anything shorter than 24 bytes and then `split_at(24)`, so the slice
handed over is always exactly 24. No change needed.

## Not fixed here

- `kek_from_webauthn_prf` still returns a bare `[u8; 32]`, so the KEK's lifetime is
  the caller's problem. Wrapping it in a zeroizing type is an API change for every
  caller.
- Base64 that does not decode and base64 that decodes to the wrong length are now
  distinguishable to a caller (`Aead` versus `NonceLength`). Both mean the record is
  unusable, and neither says anything about the key.

## Verification

- `cargo test -p opensesame-human-vault` — 14 passed (2 new: envelope nonce and
  wrapper nonce, each across 0/5/12/23/25/64 bytes plus non-base64 and the good case)
- `cargo clippy -p opensesame-human-vault --all-targets -- -D warnings` — clean
- `cargo test --workspace --lib` — green
- cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy,
  task-security-battle-test — clean
