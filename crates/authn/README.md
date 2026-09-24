# opensesame-authn

Authentication-flow building blocks for the Host / authority plane: choosing
between loopback PKCE, device authorization, CIBA and workload identity, and
the value types and checks each flow needs. It holds no network client — it
decides which flow to run, generates PKCE material, tracks device-poll state,
parses OIDC discovery fail-closed and checks token audiences.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`opensesame login` flow selection,
  device polling, `whoami`), [`opensesame-host-core`](../host-core)
  (re-exported as `host_core::authn`), and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`device_auth`,
  `oidc_discovery`, `token_audience`). [`crates/gateway`](../../crates/gateway)
  lists it as a dependency.
- **Builds on:** [`opensesame-domain`](../domain) (`OrganizationRole`).
- Flow selection is deterministic; environment heuristics affect usability,
  never security.
- A device code is kept in process memory only — never logged or persisted.
  `SessionMetadata.credential_handle` is an opaque reference, never a refresh
  token.
- A provider or MCP token presented as vault authorization is refused
  (`reject_foreign_resource_token`): no token passthrough.

## Surface

Every module is re-exported at the crate root.

| Module | Main items |
|---|---|
| `flow` | `LoginFlow` (`Auto`, `Loopback`, `Device`, `Ciba`, `Workload`), `EnvironmentSignals`, `OpenBrowser`, `resolve_login_flow`, `detect_signals_from_env` |
| `pkce` | `Pkce::s256()` |
| `device` | `DeviceAuthorization`, `DevicePollState`, `DeviceServerStatus`, `DevicePollOutcome`, `DeviceFlowError`, `validate_verification_uri_complete`, `demo_device_authorization` |
| `discovery` | `parse_oidc_discovery` (capped at `MAX_DISCOVERY_BYTES` = 4096; requires `issuer` and `jwks_uri`, HTTP(S) only, no userinfo), `assert_discovery_issuer` |
| `token` | `validate_audience`, `reject_foreign_resource_token`, `ValidatedAccessToken`, `TokenValidationError` |
| `session` | `SessionMetadata`, `WhoAmI` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-authn
```

Adversarial cases live in `src/adversarial.rs`.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology and the `host-core` facade
- [`crates/claims`](../claims) — device-code and user-code digests
