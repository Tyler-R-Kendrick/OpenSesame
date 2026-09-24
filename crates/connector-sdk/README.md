# opensesame-connector-sdk

Helpers for WIT connector guests, oriented around `ConnectionRef` rather than
secret retrieval. Today it holds one structural guarantee: a connector WIT
world must not import `secrets.get` (or `secret-get`) and must expose
`authorized-request`. Host / authority plane SDK facade.

## Where it fits

- **Used by:** no workspace crate or app. Its callers are its own tests, which
  read the repository's
  [`spec/wit/connector/world.wit`](../../spec/wit/connector/world.wit) and fail
  if the world ever gains a secret-retrieval import. `cargo test --workspace`
  (CI's Rust job) runs them.
- **Builds on:** [`opensesame-domain`](../domain) (`DomainError`).
- Line comments are stripped before the check, so documentation that mentions
  the forbidden call does not trip it.
- The same boundary is enforced on the host side by
  [`opensesame-connector-host`](../connector-host), whose Wasm linker binds no
  secret-retrieval import.

## Surface

| Item | What it does |
|---|---|
| `assert_wit_forbids_secrets_get(wit_source)` | `Err(ExportDenied)` on `secrets.get` / `secret-get`; `Err(GrantAttenuation)` when `authorized-request` is missing |
| `assert_repo_wit_forbids_secrets_get(repo_root)` | Reads `spec/wit/connector/world.wit` under `repo_root` and applies the check |
| `Result<T>` | `Result<T, DomainError>` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-connector-sdk
```

Changing `spec/wit/connector/world.wit` runs through this crate's
`contract_repo_wit_forbids_secrets_get` test.

## Related

- [ADR 0065](../../docs/adr/0065-connector-hook-architecture.md) — connector
  hook architecture; the WIT structural tests continue to refuse `secrets.get`
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) —
  `ConnectionRef` + Intent
- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — the SDK
  facades
