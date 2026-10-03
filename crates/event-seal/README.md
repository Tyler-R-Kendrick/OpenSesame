# opensesame-event-seal

Sealing for the Host's event and audit rows at rest ([ADR 0157](../../docs/adr/0157-logs-and-events-carry-no-secrets.md)).

The Host's SQLite file holds what happened: the outbox, security deliveries,
connection events, signing events, approval comments, runner steps, intents,
invocations and receipts. Each such value is sealed before it is written, under
a key derived (HKDF-SHA256) from the Host sealing key, with `table.column` in the
associated data so a value moved to another column does not open. A sealed value
is text, `osev1.` + base64url(24-byte nonce ‖ XChaCha20-Poly1305 ciphertext and
tag), so the schema and every query that does not read the value are unchanged.

## Where it fits

- **Used by:** [`opensesame-storage`](../storage) (every event column it writes
  and reads, and `Db::seal_legacy_events`), [`opensesame-connection-broker`](../connection-broker)
  (connection events and its outbox rows), [`opensesame-gateway`](../gateway)
  (installs the sealer at start-up, `src/event_sealing.rs`).
- **Builds on:** no workspace crates (`chacha20poly1305`, `hkdf`, `sha2`,
  `base64`, `zeroize`).
- **One sealer for the process**, installed once ([`install`]): free functions
  inside transactions write these rows, and a sealer plumbed through every call
  would ripple through all of them. The Host is one process with one database
  and one key. With none installed (tests, an in-memory development database)
  `seal` returns its input.

## Surface

| Item | What it does |
|---|---|
| `install(&[u8; 32])` / `clear()` / `is_active()` | Install, remove and query the process's sealer. |
| `seal(column, text)` / `seal_opt` | Seal for `table.column`; the input when none is installed. |
| `open(column, stored)` / `open_opt` | A sealed value opened; plaintext (an older build's) as it is; a sealed value that does not open, or one found with no sealer installed, is `Unreadable` and never ciphertext handed on. |
| `is_sealed(text)` / `PREFIX` | Whether a value is already sealed. |
| `EventSealer` | The sealer itself, for tests and for callers that hold their own. |

## Develop

```bash
cargo +1.88.0 test -p opensesame-event-seal
cargo +1.88.0 test -p opensesame-storage --test sealed_events   # against the real schema
```
