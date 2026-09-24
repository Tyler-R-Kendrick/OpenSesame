# Bitwarden parity: the official CLI as oracle (ADR 0141)

No screen changed. What changed is a protocol surface, so the evidence is what
Bitwarden's own client did against it.

- Oracle: `@bitwarden/cli` **2026.9.0** (`bw`), installed by
  `pnpm test:bitwarden-oracle` into `.cache/bitwarden-oracle/`.
- Transport: HTTPS with a disposable test CA (`bw` refuses plain HTTP).
- Second opinion: `crates/provider-bitwarden`, OpenSesame's own Bitwarden
  client, reads back what `bw` wrote.

## What `bw` did, and what it reported

| Scenario (`crates/bitwarden-server/tests/`) | `bw` commands | Result |
|---|---|---|
| `bw_manages_a_personal_vault_end_to_end` | `login` (wrong password, then right one with different email case), `status`, `create folder`, `create item` ×4 types, `sync --force`, `list items`, `get password/username/notes/totp/item`, `edit item`, `delete item`, `list items --trash`, `restore item`, `delete item --permanent`, `edit folder`, `delete folder`, `lock`, `unlock`, `logout`, `login` | pass; native client decrypts the same four items; no plaintext in the database |
| `bw_import_lands_whole` | `import bitwardenjson`, `list`, `get` | pass; folder relationship preserved |
| `a_pbkdf2_account_moves_to_argon2id_and_bw_follows` | `login`, `create item`, KDF change (web-vault request), `sync` (refused: session revoked), fresh `login` | pass; prelogin now Argon2id 64/3/4; item still decrypts |
| `an_imported_legacy_server_hash_upgrades_on_bw_sign_in` | `login`, `logout`, `login` | pass; stored PBKDF2 PHC hash replaced by `$argon2id$v=19$m=19456,t=2,p=1$…` |
| `bw_refreshes_short_lived_access_tokens` | `login`, `sync --force` ×2 | pass; refresh grant exercised |

Every run also asserts that `bw` made no request the server has no route for.

## Requests `bw` made during sign-in and first sync

```
GET  /bitwarden/api/config
POST /bitwarden/identity/accounts/prelogin/password
POST /bitwarden/identity/connect/token
GET  /bitwarden/api/config
GET  /bitwarden/api/sync
GET  /bitwarden/api/accounts/revision-date
POST /bitwarden/api/accounts/key-management/user-key-id
POST /bitwarden/identity/connect/token
GET  /bitwarden/api/sync
```

## Against the real binary

`opensesame host run` with `OPENSESAME_BITWARDEN_COMPAT=on`, behind a local
TLS terminator: an account registered by an independent Node.js WebCrypto
client (PBKDF2) signed in with `bw`, created a folder and a login, synced, and
read the password back. The Host's database held `$argon2id$…` for the server
hash, `kdf_type = 0 / 600000` for the client KDF, a recorded user-key id, and
no plaintext.
