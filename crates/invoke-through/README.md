# opensesame-invoke-through

The invoke-through broker on the Host / authority plane. The daemon makes an
upstream call over a credential that never leaves the machine: the token is
acquired fresh from the provider's own CLI (`gh auth token` for GitHub), held in
a `SecretString`, placed into exactly one Authorization header, and zeroized on
drop. The caller gets the upstream response and a structured receipt, nothing
else.

## Where it fits

- **Used by:** [`apps/daemon`](../../apps/daemon) (`src/invoke_through.rs`) and
  [`opensesame-connection-broker`](../connection-broker) (transport pool and
  rotation egress).
- **Builds on:** no workspace crates at runtime. `opensesame-transport-security`
  (with `testkit`) and `opensesame-domain` are dev-dependencies only, because the
  daemon's dependency budget is measured on normal edges.
- The fences, in the order they bite: an egress allowlist checked before
  connecting (exact host, https only; plain HTTP only for loopback test stubs),
  no redirects (a 3xx is returned, never followed), a memory-resident token that
  is never cached, persisted, logged or put in an error or receipt, and capped
  bodies with allowlisted headers both ways.
- Dependency budget ([ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md)):
  hyper, hyper-rustls (webpki roots), secrecy, zeroize, serde, thiserror. No
  reqwest and no cookie store.

## Surface

| Item | Role |
|---|---|
| `Invoker`, `InvokeRequest`, `InvokeResponse`, `ReceiptMeta` | Perform one brokered call and describe it without the credential |
| `DEFAULT_REQUEST_BODY_CAP`, `DEFAULT_RESPONSE_BODY_CAP`, `DEFAULT_TIMEOUT` | The default bounds (256 KiB, 1 MiB, 15 s) |
| `egress`: `EGRESS_RULES`, `rule_for`, `EgressRule`, `AuthStyle` | Static allowlist derived from the connection-broker catalogue |
| `fence`: `EgressFence`, `PreparedRequest` | Check a request against the allowlist before any socket opens |
| `TokenSource`, `source_tool`, `SourceToolSpec` | The one sanctioned way token bytes enter the path; the daemon supplies the runner |
| `tls`: `TlsClientSpec`, `Resolver` | An injected, already-validated `rustls::ClientConfig` pinned to one authority ([ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)) |
| `InvokeError` | Failure classes; never tool output or token bytes |

## Develop

```bash
cargo +1.88.0 test -p opensesame-invoke-through
pnpm audit:daemon-deps   # the daemon dependency budget this crate sits inside
```

`tests/tls_injection.rs` stands up a real mTLS listener with the
transport-security testkit; `tests/chaos.rs` injects upstream faults.

## Related

- [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) — capability-moded discovery; invoke-through is memory-resident end to end
- [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — the daemon dependency gate covers this crate's full tree
- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — injected TLS scope
- [`docs/architecture/pm-bridges.md`](../../docs/architecture/pm-bridges.md)
