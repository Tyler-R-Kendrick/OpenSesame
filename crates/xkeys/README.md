# opensesame-xkeys

X25519 recipient keys and authenticated encryption for end-to-end-encrypted
task-bus payloads. `seal` encrypts to a recipient's public key with an
ephemeral X25519 key, HKDF-SHA256 and XChaCha20-Poly1305; `open` reverses it
with the recipient's key pair. The keys are client-held.

## Where it fits

- **Used by:** [`opensesame-task-bus`](../task-bus) (`src/envelope.rs`) and the
  fuzz crate [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`xkeys_envelope`).
- **Builds on:** no workspace crates (`x25519-dalek`, `chacha20poly1305`,
  `hkdf`, `sha2`, `zeroize`).
- Hard rule: this crate never uses the Host connection seal key, the deployment
  seal key, or any broker credential-wrapping key.
- It is not the NATS `xkv1` envelope. [`opensesame-nats-callout`](../nats-callout)
  uses `nkeys`' implementation for that, because the format has to be the
  server's.

## Surface

| Item | Role |
|---|---|
| `XKeyPair` | `generate`, `from_secret_bytes`, `public_bytes`, `public_key`; the secret half is zeroized on drop |
| `seal(plaintext, &PublicKey) -> Result<Vec<u8>, XkeysError>` | Output: `version (1) \|\| ephemeral_pk (32) \|\| nonce (24) \|\| ciphertext+tag` |
| `open(sealed, &XKeyPair) -> Result<Vec<u8>, XkeysError>` | Refuses an unknown version, a short blob, or a failed tag |
| `SEAL_VERSION` | `1` |
| `XkeysError` | `Aead`, `Kdf`, `UnsupportedVersion`, `Truncated`, `PublicKeyLength` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-xkeys
```

Property tests use `proptest`; saved failure seeds are in
[`proptest-regressions/`](proptest-regressions) and re-run first.

## Related

- [ADR 0042](../../docs/adr/0042-nats-taskbus-auth-callout-and-xkeys.md) — NATS task bus, auth callout and xkeys
