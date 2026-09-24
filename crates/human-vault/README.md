# opensesame-human-vault

Server-blind end-to-end encryption for the human vault, shared by the vault
and the sealed store. Items are sealed with XChaCha20-Poly1305 under per-item
data keys, with associated data that binds the organization, project,
collection, item, key and revision; the server stores ciphertext only, and the
vault root key (VRK) never leaves the client. The crate also carries password
wrapping (Argon2), WebAuthn-PRF key derivation, chunked attachment sealing, and
the root-protection model shared by browser and native clients, and
`pages_vault`: a reader for the vault the Pages PWA writes, so the native
binary opens it (`opensesame vault verify|ls`).

## Where it fits

- **Used by:** [`opensesame-sealed-store`](../sealed-store) (envelopes,
  attachments, root protection, rotation),
  [`opensesame-client-core`](../client-core) (re-exported as `human_vault`),
  [`apps/cli`](../../apps/cli) (`vault_migration.rs`, `vault_file.rs`), and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`vault_envelope`,
  `attachment_chunk`).
- **Builds on:** no workspace crates at runtime (`opensesame-domain` is a
  dev-dependency) — `argon2`, `chacha20poly1305`, `aes-gcm`, `hkdf`, `hmac`,
  `pbkdf2`, `unicode-normalization`, `blake3`, `zeroize`.
- Key types (`VaultRootKey`, `ItemDataKey`, `AttachmentKey`) zeroize on drop.
- WebAuthn PRF output never leaves the client; `kek_from_webauthn_prf` derives
  a KEK from it with domain separation.
- Argon2 parameters are admitted against a floor (`MIN_ARGON_M_KIB` = 64 MiB,
  `MIN_ARGON_T` = 3) and per-platform ceilings; an untrusted wrapper cannot
  select a policy (`kdf_policy`).
- This is one of two vault formats: the Pages tomb uses PBKDF2 and AES-GCM, and
  converging them is out of scope (ADR 0133). `pages_vault` reads that second
  format as [vault format v1](../../docs/architecture/vault-format-v1.md) §9
  asks: envelope rules first, the KDF validated before deriving, NFKC before
  PBKDF2, the body opened bound to its tomb (falling back to a legacy unbound
  seal and saying so), a rollback against `bodyRev` reported, VK zeroized, and
  nothing listed but names, kinds and paths.

## Surface

| Area | Main items |
|---|---|
| Item envelopes | `encrypt_item`, `decrypt_item`, `decrypt_item_with_ad`, `EncryptedEnvelope`, `AssociatedData`, `ad_digest`, `ENVELOPE_VERSION`, `VaultCryptoError` |
| Keys | `VaultRootKey`, `ItemDataKey`, `kek_from_webauthn_prf` |
| Password wrapping | `wrap_vrk_with_password`, `unwrap_vrk_with_password`, `PasswordWrapper`, `assert_argon_params_accepted`, `migrate_password_wrapper_offline` (not on `wasm32`) |
| Attachments | `derive_attachment_key`, `seal_chunk`, `open_chunk`, `ChunkAd`, `chunk_ad_digest`, `OSCHUNK_MAGIC` (`OSCHNK1\n`) |
| `kdf_policy` | `KdfPolicy` (`Native`, `Browser`) and its ceilings |
| `pages_vault` | The Pages vault reader: `read_vault_file` (export and offline-backup envelopes), `unwrap_with_password` / `unwrap_with_pin` / `unwrap_with_prf`, `open_body`, `summarize`, `open_vault_file`; errors `VaultFileError::{Corrupt, WrongPassword, Rejected}` |
| `root_protection` | Versioned key files and manifests, root capsules, protectors (password, recovery key, age recipient), cloud-local envelopes, legacy password-wrapper unlock |

On `wasm32`, `getrandom` is built with its `js` feature.

## Develop

```bash
cargo +1.88.0 test -p opensesame-human-vault
pnpm audit:miri      # runs this crate's trust-boundary rejection tests under Miri
```

These formats are archives. `tests/format_stability.rs` pins the attachment
key derivation, associated-data digest and frame layout; a failure there means
the change would make every sealed attachment unreadable, not that the
expected value needs updating. The envelope wire shape is pinned by an `insta`
snapshot in `src/snapshots/`. `tests/root_protection_vectors.rs` checks
cross-language vectors in `tests/fixtures/root_protection_shared_vectors.json`.
`tests/pages_vault_vectors.rs` opens the golden Pages vault vectors in
[`spec/conformance/vault-vectors.json`](../../spec/conformance/vault-vectors.json)
— the same file `packages/vault-core` reads — and
`tests/pages_vault_envelopes.rs` holds the §7 envelope refusals.

## Related

- [ADR 0037](../../docs/adr/0037-git-sealed-store.md) — the git sealed store
  reuses these AEAD primitives
- [ADR 0038](../../docs/adr/0038-project-hierarchy-sharing.md) — project binding
  in envelope associated data
- [ADR 0133](../../docs/adr/0133-shared-app-core.md) — the two vault formats
- [`docs/security/key-hierarchy.md`](../../docs/security/key-hierarchy.md)
