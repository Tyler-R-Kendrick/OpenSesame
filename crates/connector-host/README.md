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
  `host_core::connector_host`), [`crates/gateway`](../../crates/gateway),
  [`crates/worker`](../worker) and [`apps/cli`](../../apps/cli) (the
  `providers` catalogue and plans, and `password_agent`), and the fuzz harness
  in [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`connector_yaml`).
- **Builds on:** [`opensesame-domain`](../domain) (`EgressBinding`,
  `InvokeLevel`), [`opensesame-invoke-through`](../invoke-through) (the
  surrogate ledger and the broker L2 constrained HTTP runs through) and
  [`opensesame-sealed-store`](../sealed-store) (the `password-store` and
  `sealed-local` providers in `providers`).
- L2 constrained HTTP has one rule set, invoke-through's (ADR 0150 §6.7). A
  connection's placeholder is an `osr_` surrogate the host's ledger issued;
  it is admitted only as the entire value of its declared site, once, from
  the connector binding it was issued to, to a host its provider's rule
  names, inside its method and path scope. The header it arrived in is
  stripped and the broker writes the credential into the provider's own
  site; no caller text is ever rewritten into a credential. Anywhere else
  (the body beside a valid header, the query, a second header, a header
  name) is refused and logged as a `surrogate.*` tripwire whose detail never
  repeats the placeholder.
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
| `HostRuntime` | `register_connector`, `bind_connection`, `bind_provider`, `connector_for_provider`, `component_digest`, `invoke`; L2: `register_connection` (hold a credential, issue its placeholder), `invoke_constrained_http` (admit, then send through an `Invoker`), `revoke_run` |
| `HostPolicy`, `HostError` | Allowed hosts, signature requirement, trusted digests, max invoke level, egress binding |
| `Connector` trait, `MockConnector` | The connector interface and the demo implementation |
| `InvokeRequest`, `InvokeResult` | One invocation in and out |
| `assert_component_trusted`, `assert_destination_allowed`, `is_blocked_host` | The trust and egress checks |
| `authorized_http_request`, `follow_redirect_with_credential`, `opensesame_param_digest` | Credential injection and parameter digests |
| `Surrogate`, `SurrogateSpec`, `SurrogateSite`, `RefusalCode` | Re-exported from invoke-through for L2 callers |
| `manifest` | `ConnectorManifest` for `connectors/<id>/connector.yaml` (`opensesame.dev/v1alpha1`, `ConnectorDefinition`, max 64 KiB) |
| `providers` | External secret-provider catalogue (`catalog`, `find`), `probe_local` / `probe_live`, `human_plan` / `execute_human_plan`, `crypto_plan` / `execute_crypto_plan` |
| `password_agent` | Human-operated 1Password-parity planning over the `op` CLI's output (`documents`, `reference`, `validate_summary`, `validate_item`; `discover`, `env`, `lease`, `policy`, `request`, `service`, `writes`); no guest materialization path |
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
and deadline limits. `tests/constrained_http_e2e.rs` sends L2 requests through
the broker to a TLS upstream standing in for `api.github.com` and asserts what
it received: the credential once, the placeholder never, and nothing reflected
back into the summary.

## Related

- [ADR 0065](../../docs/adr/0065-connector-hook-architecture.md) — connector
  hook architecture, manifests and the Wasm runtime
- [ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md) —
  surrogate credentials at the last hop; §6.7 retired the L2 placeholder
  simulation into this path
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) —
  `ConnectionRef` + Intent, no secret handles
- [`spec/wit/connector/world.wit`](../../spec/wit/connector/world.wit) — the
  connector world
