# @opensesame/client-core

The TypeScript façade over the Rust `client-core` sync shapes for the Client
plane: the sync cursor and ciphertext blob types, base64 helpers, and the
sealed store that persists sync state to the origin-private file system (OPFS),
or to memory when OPFS is unavailable. It persists ciphertext only; the AEAD
itself belongs to the Rust crate
[`crates/client-core`](../../crates/client-core) (its `wasm-bindgen` feature).

## Where it fits

- **Used by:** [`packages/api-client`](../api-client) (`SyncBlob` and
  `SyncCursor` for sync push and pull) and
  [`apps/browser-extension`](../../apps/browser-extension).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (JSON guards).
- `persistSealedStore` refuses a document that is not exactly a cursor plus
  base64 blobs, and refuses a store whose cursor names another device. The
  memory fallback is never `localStorage`.
- `sealDevOnly` is a deprecated XOR kept for development: it throws unless the
  run can prove it is development or test (`NODE_ENV`, or the
  `__OPENSESAME_ALLOW_DEV_SEAL__` opt-in).

## Surface

| Export | What it does |
|---|---|
| `SyncCursor`, `SyncBlob`, `createCursor(deviceId)` | Sync shapes mirroring the Rust crate |
| `bytesToB64`, `b64ToBytes` | Base64 helpers |
| `SealedStore`, `parseSealedStore` | The on-disk shape, and its parser (null when the document is not one) |
| `persistSealedStore(name, json)`, `loadSealedStore(name)` | OPFS or in-memory persistence, one file per device |
| `assertNoPlaintextInSealedJson(json)` | Throws unless the document is a sealed store |
| `sealDevOnly` | Deprecated development-only seal |

## Develop

```bash
pnpm --filter @opensesame/client-core test
pnpm --filter @opensesame/client-core typecheck
```

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology
- [`docs/security/audits/2026-08-08-project-expiry.md`](../../docs/security/audits/2026-08-08-project-expiry.md)
  — the `sealDevOnly` production guard
