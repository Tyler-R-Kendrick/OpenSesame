# opensesame-client-core

The client-core SDK facade for the Client plane: local end-to-end encryption and
ciphertext sync cursors, built natively and, behind a feature, for Wasm. A
device seals blobs under its own key (XChaCha20-Poly1305), and a `SyncStore`
tracks what to push and what it has already applied by epoch. The server only
ever stores ciphertext; persisted state is sealed blobs, never plaintext.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway), for the `SyncBlob` shape in
  the sync routes (`routes/sync.rs`, `routes/sync_blobs.rs`). The TypeScript
  package [`@opensesame/client-core`](../../packages/client-core) mirrors its
  sync shapes by hand; it does not load this crate.
- **Builds on:** [`opensesame-core`](../core) and
  [`opensesame-human-vault`](../human-vault), both re-exported (`core`,
  `human_vault`).
- A snapshot file is as sensitive as the vault: sealed AEAD blobs only, never
  plaintext and never a vault recovery key. `assert_ciphertext_only_json`
  checks a snapshot's JSON, and `refuse_deployment_seal_as_wrap_key` refuses a
  deployment seal offered as a wrap key.
- Key material zeroizes on drop.

## Surface

| Item | What it is |
|---|---|
| `DeviceKey` | `generate`, `from_bytes`, `as_bytes` |
| `seal`, `open` | AEAD over a device key, with associated data |
| `SyncStore` | `new(device_id)`, `put_local`, `apply_remote`, `collect_outgoing(since)` |
| `SyncCursor`, `SyncBlob` | The sync wire shapes |
| `snapshot` | `CiphertextSyncSnapshot` (`validate`, `to_json`, `from_json`, `export_ciphertext_snapshot`, `import_ciphertext_snapshot`), `SNAPSHOT_FORMAT`, `SNAPSHOT_VERSION` |
| `wit_contract::PACKAGE` | `opensesame:client@1.0.0` — the `spec/wit/client` world |
| `wasm` (feature `wasm-bindgen`) | `WasmDeviceKey`, `WasmSyncStore`, `wasm_seal`, `wasm_open`, `wit_package` |

| Cargo feature | Effect |
|---|---|
| `wasm-bindgen` | Adds `wasm-bindgen`, `serde-wasm-bindgen`, `js-sys` and the `wasm` module |

On `wasm32`, `getrandom` is built with its `js` feature.

## Develop

```bash
cargo +1.88.0 test -p opensesame-client-core
cargo +1.88.0 check -p opensesame-client-core --features wasm-bindgen
```

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology and the SDK facades
- [`spec/wit/client/world.wit`](../../spec/wit/client/world.wit) — the WIT world
