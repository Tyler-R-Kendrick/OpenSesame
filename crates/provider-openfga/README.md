# opensesame-provider-openfga

The OpenFGA remote PDP adapter for the Host / authority plane: an HTTP client
against a live OpenFGA server, and the mapping from a Host `Grant` onto OpenFGA
relationship tuples. When `OPENSESAME_OPENFGA_URL` is unset, callers may fall
back to the in-process PEP. A projected tuple is never itself authority.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (`src/openfga_project.rs`
  projects each grant under the authority writer lease; app state and intent
  projection) and the fuzz crate [`tests/fuzz/cargo`](../../tests/fuzz/cargo)
  (`openfga_response`).
- **Builds on:** [`opensesame-domain`](../domain) (`Grant`); `reqwest`.
- The PDP base URL must be https or loopback http, with no userinfo
  (`assert_pdp_base_url`).
- A grant the mapping refuses is left unprojected, so the gateway's freshness
  check stays fail-closed.

## Surface

| Item | Role |
|---|---|
| `OpenFgaClient::from_env` | Reads `OPENSESAME_OPENFGA_URL` and `OPENSESAME_OPENFGA_STORE_ID` (required once the URL is set); `None` when the URL is unset |
| `OpenFgaClient` | `health`, `create_store`, `write_authorization_model`, `write_tuples`, `check_tuple`, `connection_model` |
| `RemotePdp`, `TupleKey` | The `check` trait and its tuple |
| `grant_to_openfga_tuples`, `invoke_check_tuple`, `GrantTupleMappingError`, `GrantTupleMappingResult` | Grant-to-tuple projection and the check tuple for an invocation |
| `parse_check_response`, `assert_pdp_base_url` | Response parsing and URL guard |
| `bootstrap_demo_store` | Creates an `opensesame-demo` store for live scripts and tests |
| `OpenFgaError`, `Result` | Error type |

## Develop

```bash
cargo +1.88.0 test -p opensesame-provider-openfga
# The live check is #[ignore]d and needs a running OpenFGA
OPENSESAME_OPENFGA_URL=http://127.0.0.1:8080 \
  cargo +1.88.0 test -p opensesame-provider-openfga -- --ignored
pnpm test:live-stack   # live OpenFGA/OpenBao/gateway
```

The authorization model and baseline tuples live in
[`spec/openfga`](../../spec/openfga).

## Related

- [ADR 0002](../../docs/adr/0002-foundations.md) — foundations: provider logic stays in adapter crates
- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) — generalized hierarchical authority
