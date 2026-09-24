# opensesame-sealed-store

The git-native hierarchical sealed secret store behind `opensesame pass`, with
`pass` parity. Ciphertext files live under a store root (default
`~/.password-store`), one per entry, committed to git and pushed to a backup
remote. Agents never receive plaintext through the surface Host invoke paths
use; reveal is a human CLI concern.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (the `pass` verbs, attachments,
  root protection, OTP), [`apps/pm-bridges`](../../apps/pm-bridges),
  [`opensesame-connector-host`](../connector-host),
  [`opensesame-kdbx-bridge`](../kdbx-bridge),
  [`opensesame-vault-item-types`](../vault-item-types), and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`attachment_chunk`).
- **Builds on:** [`opensesame-human-vault`](../human-vault) (the E2EE envelope,
  item and vault-root keys, root protection) and
  [`opensesame-authenticator-core`](../authenticator-core) (TOTP/HOTP and
  `otpauth://` trailers). `age` for age-format entries.
- `git`, `gpg`, `sops` and `ykman` are external processes, not linked
  libraries. SOPS is resolved only from an absolute `OPENSESAME_SOPS_BIN`, and
  PIV discovery never runs a destructive `ykman` command.

## Surface

| Area | Items |
|---|---|
| Store | `init_store`, `init_store_key`, `unlock_store_key`, `list_names`, `StoreRoot`, `resolve_store_dir`, `FormatHint` (`Osseal`, `Gpg`, `Age`) |
| Entries | `Entry`, `apply_secret_update`, `rotate_secret_entry`, `UpdateOptions`, `generate_password`, `entry_history`, `restore_entry` |
| Formats | `seal_osseal` / `open_osseal` (`OSSEAL1` envelope), `encrypt_age_file` / `decrypt_age_file`, `encrypt_gpg_file` / `decrypt_gpg_file`, `sops_encrypt` / `sops_decrypt` |
| Git | `ensure_git_repo`, `auto_commit`, `push_backup`, `set_remote`, `set_auto_push`, `git_passthrough`, `GIT_TOKEN_ENV` |
| Attachments | `AttachmentManifest`, `ChunkRef`, `GcOutcome`, `MAX_ATTACHMENT_BYTES` — chunked, content-addressed, each chunk sealed separately |
| Tombs | `TombRegistry`, `TombEntry`, `load_tomb_registry`, `resolve_tomb_paths`, `ensure_personal_project_tomb` |
| Root protection and rotation | `protect_*`, `rotate_store_root`, `Recipients`, `discover_piv_age` |
| Pages bridge | `parse_manifest`, `seal_manifest` — seal a Pages path manifest into entries and one commit |
| Paths | `logical_to_relative`, `relative_to_logical`, `ObjectStore`, `FsObjectStore`, `assert_confined_rel` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-sealed-store
pnpm test:mutation:rust   # src/attachment.rs is in the mutation scope
```

`tests/manifest_snapshot.rs` pins the manifest shape with `insta`. The store is
driven end to end from the CLI; see the `pass` section of
[`AGENTS.md`](../../AGENTS.md).

## Related

- [ADR 0037](../../docs/adr/0037-git-sealed-store.md) — git sealed store
- [ADR 0038](../../docs/adr/0038-multi-tomb-sealed-store.md) — multi-tomb sealed store
- [ADR 0054](../../docs/adr/0054-file-attachment-storage.md) — file attachment storage
- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md) — password-manager ecosystem bridging
- [`docs/security/audits/2026-09-23-sealed-store-root-protection.md`](../../docs/security/audits/2026-09-23-sealed-store-root-protection.md)
