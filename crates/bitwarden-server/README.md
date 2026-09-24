# opensesame-bitwarden-server

A Bitwarden-compatible server. Point a Bitwarden client — `bw`, the browser
extension, the desktop or mobile app — at the Host's `/bitwarden` URL and it
signs in, unlocks, syncs and edits a personal vault as it would against
Bitwarden's own server ([ADR 0141](../../docs/adr/0141-bitwarden-compatible-server.md)).

## Where it fits

- **Used by:** [`crates/gateway`](../gateway) (`src/bitwarden_compat.rs`), which
  mounts it at `/bitwarden` when `OPENSESAME_BITWARDEN_COMPAT=on`. Off by default.
- **Builds on:** [`crates/storage`](../storage) (`bitwarden_accounts.rs`,
  `bitwarden_vault.rs`, migration `0042_bitwarden_compat`). `argon2`,
  `pbkdf2` (verify only), `jsonwebtoken`, `axum`.
- **Tested with:** [`crates/provider-bitwarden`](../provider-bitwarden) as an
  independent client, and the official `@bitwarden/cli` as the oracle.
- Human plane only. Every value a client encrypts is an opaque `EncString`
  here; the server holds no key that opens a vault. The capability entry
  (`host.bitwarden_compat`) excludes every agent surface.
- The protocol is implemented from observed client behaviour; no Bitwarden or
  vaultwarden (AGPL/GPL) source is copied.

## Two KDFs, both replaceable

| | Who runs it | Default | How it is replaced |
|---|---|---|---|
| Client KDF (`kdf`) | the Bitwarden client, over the master password | Argon2id, 64 MiB / 3 / 4 | a new `KdfType` and one row in `kdf::RULES` |
| Server hash (`hashing`) | the server, over the client's master-password hash | Argon2id v1.3, 19 MiB / 2 / 1 (PHC string) | implement `PasswordHashScheme`, make it current in `HashRegistry`, keep Argon2id accepted — each account re-hashes on its next sign-in |

PBKDF2-SHA256 PHC hashes (what Bitwarden's server and vaultwarden store) are
accepted verify-only and upgraded on first sign-in.

## Surface

| Item | Role |
|---|---|
| `BitwardenServer::new(db, ServerConfig, HashRegistry, token_secret)` | Shared state |
| `BitwardenServer::router()` | Every route, relative to the configured server URL |
| `ServerConfig`, `SignupPolicy` | Public URL, signups (closed by default), KDF policy, token TTL, hash concurrency |
| `hashing::{HashRegistry, PasswordHashScheme, Argon2idScheme, Pbkdf2Sha256Legacy, Verdict}` | The replaceable server hash |
| `kdf::{KdfType, KdfConfig, KdfPolicy, RULES}` | The client KDF's accepted ranges |
| `tokens::TokenKeys` | Access (JWT, Bitwarden claim names), refresh (opaque, stored hashed) and registration tokens |

## Develop

```bash
cargo +1.88.0 test -p opensesame-bitwarden-server   # unit + tests/protocol.rs
pnpm test:bitwarden-oracle                          # + the bw CLI oracle suites
```

`tests/bw_cli_oracle.rs` and `tests/bw_cli_oracle_accounts.rs` are `#[ignore]`d
and need `OPENSESAME_BW_CLI`; the pnpm script installs the pinned CLI into
`.cache/bitwarden-oracle/` and sets it. They fail, never skip, without it.
