# opensesame-connector-host

Hosts connectors for the Host / authority plane. A connector gets host
capabilities — authorized HTTP, signing, opaque token handles — and never a
`secrets.get`: guests hold a connection handle, and the host injects material
only on the way out. `HostRuntime` registers connectors, binds connections and
providers to them, and runs an invocation under `HostPolicy` (egress allowlist,
trusted component digests, maximum invoke level). The crate also parses
connector manifests, carries the external secret-provider catalogue, and — behind
a feature — runs Wasm component connectors.

## Where it fits

- **Used by:** [`opensesame-broker`](../broker) (`HostRuntime::invoke`),
  [`opensesame-host-core`](../host-core) (re-exported as
  `host_core::connector_host`), [`apps/gateway`](../../apps/gateway),
  [`apps/worker`](../../apps/worker) and [`apps/cli`](../../apps/cli) (the
  `providers` catalogue and plans), and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`connector_yaml`).
- **Builds on:** [`opensesame-domain`](../domain) (`EgressBinding`,
  `InvokeLevel`, placeholder projections) and
  [`opensesame-sealed-store`](../sealed-store) (the `password-store` and
  `sealed-local` providers in `providers`).
- Destinations must be HTTPS, inside the egress policy, and not loopback,
  private, link-local or a metadata endpoint. `is_blocked_host` parses address
  literals rather than prefix-matching them.
- A manifest is inert data: parsing never executes, fetches or registers
  anything, every struct rejects unknown fields, and no field can carry
  credential material.
- The Wasm runtime is default-off. Only the gateway enables it; the daemon
  dependency gate bans `wasmtime` from daemon trees (ADR 0065 §3).

## Surface

| Item | What it is |
|---|---|
| `HostRuntime` | `register_connector`, `bind_connection`, `bind_provider`, `connector_for_provider`, `component_digest`, `invoke` |
| `HostPolicy`, `HostError` | Allowed hosts, signature requirement, trusted digests, max invoke level, egress binding |
| `Connector` trait, `MockConnector` | The connector interface and the demo implementation |
| `InvokeRequest`, `InvokeResult` | One invocation in and out |
| `assert_component_trusted`, `assert_destination_allowed`, `is_blocked_host` | The trust and egress checks |
| `authorized_http_request`, `follow_redirect_with_credential`, `substitute_placeholder`, `opensesame_param_digest` | Credential injection and parameter digests |
| `manifest` | `ConnectorManifest` for `connectors/<id>/connector.yaml` (`opensesame.dev/v1alpha1`, `ConnectorDefinition`, max 64 KiB) |
| `providers` | External secret-provider catalogue (`catalog`, `find`), `probe_local` / `probe_live`, `human_plan` / `execute_human_plan`, `crypto_plan` / `execute_crypto_plan` |
| `wasm` (feature `wasm-connectors`) | `WasmConnector`, `GuestLimits`, `HostEgress` — binds only `types`, `host-http`, `host-crypto`, `host-oauth`; a fresh `Store` per invocation under fuel, epoch and memory limits; the component's sha256 must match the manifest and be pinned in `trusted_digests` |

| Cargo feature | Effect |
|---|---|
| `wasm-connectors` | Enables `wasmtime` and the `wasm` module (the gateway's `wasm-connectors` feature turns it on) |

## Develop

```bash
cargo +1.88.0 test -p opensesame-connector-host
cargo +1.88.0 test -p opensesame-connector-host --features wasm-connectors --test wasm_runtime
pnpm audit:daemon-deps
```

`tests/wasm_runtime.rs` uses a hand-written WAT component to exercise the fuel
and deadline limits.

## Related

- [ADR 0065](../../docs/adr/0065-connector-hook-architecture.md) — connector
  hook architecture, manifests and the Wasm runtime
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) —
  `ConnectionRef` + Intent, no secret handles
- [`spec/wit/connector/world.wit`](../../spec/wit/connector/world.wit) — the
  connector world
