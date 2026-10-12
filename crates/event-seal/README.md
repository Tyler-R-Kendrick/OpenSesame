# opensesame-event-seal

Sealing for the Host's event and audit rows at rest ([ADR 0157](../../docs/adr/0157-logs-and-events-carry-no-secrets.md)).

The Host's SQLite file holds what happened: the outbox, security deliveries,
connection events, signing events, approval comments, runner steps, intents,
invocations and receipts. Each such value is sealed before it is written, under
a key derived (HKDF-SHA256) from the Host sealing key, with `table.column` in the
associated data so a value moved to another column does not open. Current
`osev2.` envelopes use a fresh data key per value, wrapped under the customer
key, and authenticate the trusted customer and record context. Configured
runtime readers refuse plaintext and `osev1.` downgrades. The explicit startup
migration reader can import older rows before the Host serves requests.

## Where it fits

- **Used by:** [`opensesame-storage`](../storage) (every event column it writes
  and reads, and `Db::seal_legacy_events`), [`opensesame-connection-broker`](../connection-broker)
  (connection events and its outbox rows), [`opensesame-gateway`](../gateway)
  (installs the sealer at start-up, `src/event_sealing.rs`) and
  [`opensesame-sealed-log`](../sealed-log).
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
| `seal_in(customer, column, record, text)` | Seal under the customer's key, binding the trusted record id. |
| `open(column, stored)` / `open_opt` | Current envelopes only when configured; plaintext only in unconfigured development. |
| `open_in(customer, column, record, stored)` | Current envelopes bound to trusted customer and row; legacy values fail closed. |
| `open_legacy_for_migration(column, stored)` | Explicit startup migration only; legacy values have no authenticated customer or row identity. |
| `is_sealed(text)` / `PREFIX` | Whether a value is already sealed. |
| `EventSealer` | The sealer itself, for tests and for callers that hold their own. |

## Develop

```bash
cargo +1.88.0 test -p opensesame-event-seal
cargo +1.88.0 test -p opensesame-storage --test sealed_events   # against the real schema
```

Host startup refuses plaintext and `osev1` event rows by default, including on
restart. For a one-time upgrade of a trusted database, set
`OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION=true` (only the exact value `true`
enables import). Stop writers and verify database provenance before importing;
legacy ciphertext cannot prove its customer or record ownership. Disable this
flag immediately after upgrade. Leaving it enabled permits legacy replay on
restart. Ordinary startup validates current envelope prefixes without legacy
decryption or rewriting.
