# opensesame-host-core

The host-core SDK facade for the Host / authority plane (ADR 0017). It
re-exports the authority crates under one name and adds the pieces every local
host binary shares: daemon listen defaults and bind policy, strict deployment
mode, the operator bearer check, route-scoped CORS and response hardening, and
the PACT test oracles. It corresponds to the `opensesame:host@1.0.0` WIT world.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway),
  [`crates/daemon`](../../crates/daemon), and
  [`apps/cli`](../../apps/cli) (the `opensesame daemon` verbs). They use the modules below;
  none of them reaches the re-exported crates through this facade today — each
  depends on those crates directly.
- **Builds on:** [`opensesame-core`](../core), [`opensesame-broker`](../broker),
  [`opensesame-authz`](../authz), [`opensesame-authn`](../authn),
  [`opensesame-connector-host`](../connector-host),
  [`opensesame-env-spec`](../env-spec), [`opensesame-audit`](../audit); `axum`
  and `tower-http` for the HTTP layers.
- Transport locality never supplies authorization. Loopback is not a boundary:
  every mutating local route wants the operator bearer check.
- No implicit browser trust: CORS is an exact-origin allowlist, per route.

## Surface

| Item | What it is |
|---|---|
| `audit`, `authn`, `authz`, `broker`, `connector_host`, `core`, `env_spec` | Re-exported crates |
| `wit_contract::PACKAGE` | `opensesame:host@1.0.0` ([`spec/wit/host/world.wit`](../../spec/wit/host/world.wit)) |
| `daemon` | `DEFAULT_LISTEN` (`127.0.0.1:18790`), `listen_host_is_loopback`, `assert_tcp_listen_allowed`, `uds_only_requested`, `base_url_is_local`; env names `OPENSESAME_DAEMON_LISTEN` (alias `OPENSESAME_DAEMON_LISTEN`), `OPENSESAME_DAEMON_UDS_ONLY`, `OPENSESAME_ALLOW_NONLOCAL`, `OPENSESAME_DAEMON_ALLOW_NONLOCAL` |
| `deployment_mode` | `DeploymentMode`, `ExposureClass`, `Deployment` (`production_safeguards`), `resolve`, `from_env`, `classify`, `endpoint_exposure` — reads `OPENSESAME_ENV` (which must agree with `NODE_ENV`) and `OPENSESAME_ALLOW_DEV_DEFAULTS` (local-only exposure) |
| `operator` | `check(expected, headers)`, `token_from_headers`, `constant_time_eq`, `OperatorDenial` |
| `http_security` | `browser_cors_layer`, `public_cors_layer`, `apply_security_headers`, `apply_http_security`, `parse_cors_origins`, `cors_origins_from_env` (`OPENSESAME_CORS_ORIGINS`), `is_exact_origin`, `is_safe_path_id`, `is_hop_or_forwarding_header` |
| `pact` | Property / Adversarial / Chaos / conTract oracles shared by Host tests |
| `duress` | Optional independent-authority duress hold, quarantine and recovery (`IndependentHold`, `DurableEpochs`, `ceiling_for_hold`); timer expiry never unlocks |

## Develop

```bash
cargo +1.88.0 test -p opensesame-host-core
```

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology and the SDK facades
- [ADR 0045](../../docs/adr/0045-hosted-ceremony-pages.md) — hosted ceremony
  pages and the frame-denial headers `http_security` sets
- [ADR 0130](../../docs/adr/0130-duress-profiles-trust-boundaries.md) — duress
  profiles and trust boundaries
- [`docs/validation/pact.md`](../../docs/validation/pact.md) — the PACT method
