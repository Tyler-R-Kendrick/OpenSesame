# opensesame-sandbox

Bounded, brokered execution of untrusted guest code for general authority on
the Host / authority plane. A sandboxed run is arbitrary WebAssembly whose
entire authority comes from a validated grant chain at spawn time; it gets
nothing ambient. It is the general-authority sibling of
[`opensesame-connector-host`](../connector-host)'s component runtime: the same
posture for code that has no manifest, pinned digest or fixed WIT world.

## Where it fits

- **Used by:** no workspace crate or app depends on it today. It is exercised by
  its own tests and by the authority-fabric gate (`pnpm test:authority-fabric`),
  whose scenarios `AT-SANDBOX`, `GA-V-60` and others run this crate's
  integration tests with `--features wasm-runtime,fixtures`. It is not a fuzz
  target.
- **Builds on:** [`opensesame-domain`](../domain)
  (`ValidatedGrantChain`); `wasmtime` behind a feature.
- No `get_secret`, no credential in guest memory, no token bytes: a guest that
  acquires a token gets an opaque integer handle (ADR 0005, stated in an ABI
  rather than a WIT world).
- A payload that is not a wasm core module (an ELF, a Mach-O, a PE, a `#!`
  script) is refused, never run natively.

## Surface

| Property | Items |
|---|---|
| Profile | `SandboxProfile`, `AmbientDenial` — derived only from a `ValidatedGrantChain`; no `Default`, no `Deserialize` |
| Spawn (`wasm-runtime`) | `Sandbox`, `RunOutcome`, `KillSwitch` — a fresh Wasmtime store per run with fuel, an epoch deadline and a memory cap set before the first instruction |
| Boundary | `Broker`, `DenyAll`, `RunContext`, `Refusal`, `ImportKind`, `BrokeredCapability`, `BROKERED_MODULE` (`opensesame:sandbox`) — at most four host functions; any other import is refused at link time |
| Budget | `ResourceBudget` (`CEILING` is bounded, never unlimited) |
| Revoke | `RevocationLedger`, `RevocationFence` — a generation fence that closes the boundary and traps a running guest |
| Format | `GuestFormat` |
| Contract | `wit_contract::PACKAGE` = `opensesame:core@1.0.0` |

| Cargo feature | Effect |
|---|---|
| `wasm-runtime` (off by default) | Links Wasmtime and exports `runtime`. Off so the policy types stay linkable by trees that may not pull in a JIT ([ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) §5) |
| `fixtures` | Exports grant-chain builders for tests |

## Develop

```bash
cargo +1.88.0 test -p opensesame-sandbox
cargo +1.88.0 test -p opensesame-sandbox --features wasm-runtime,fixtures
pnpm test:authority-fabric
```

Every file in [`tests/`](tests) is compiled only with both features, so the
first command runs the unit tests alone. The integration tests assemble hostile
guests from WAT with the `wat` dev-dependency (the sandbox itself refuses WAT
text): WASI importers, fuel burners, memory bombs, out-of-bounds pointers, emit
floods and a revocation landing mid-loop.

## Related

- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) — generalized hierarchical authority
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — authority handle and ConnectionRef
- [`docs/operators/general-authority-support-matrix.md`](../../docs/operators/general-authority-support-matrix.md)
