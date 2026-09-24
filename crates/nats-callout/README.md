# opensesame-nats-callout

The NATS auth-callout protocol (ADR-26 in the NATS server's numbering) for the
Host / authority plane, and the native `$SYS.REQ.USER.AUTH` bridge built on it.
The bridge takes a server-signed `authorization_request`, asks the Host for a
decision over mTLS, and answers with a signed `authorization_response`. It
attests one fact the Host cannot see for itself: the request arrived on the
bridge's authenticated NATS connection, on the protected subject. The Host
re-verifies everything else from the raw request JWT the bridge forwards.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) (the decision route in
  `src/routes/nats_callout.rs`) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`transport_callout_envelope`).
  The bridge binary is its own deployable.
- **Builds on:** [`opensesame-authz`](../authz), [`opensesame-domain`](../domain)
  and [`opensesame-transport-security`](../transport-security) (every TLS config;
  this crate builds none).
- The bridge is high-trust, not compromise-resistant: a compromised bridge can
  replay server requests it has seen, never mint an allow decision.
- `client_tls.certs` in a request is never evidence. The `xkv1` envelope uses
  `nkeys`' implementation, not [`opensesame-xkeys`](../xkeys), because it has to
  match the server's wire format.
- Never a dependency of `crates/core`, `crates/client-core` or `apps/daemon`.

## Surface

| Item | Role |
|---|---|
| binary `opensesame-nats-auth-bridge` | Subscribes to `AUTH_SUBJECT` in queue group `QUEUE_GROUP`; environment-only configuration, a missing identity, trust bundle, seed or Host URL is a startup error |
| `jwt`: `decode_request`, `Expectations`, `VerifiedRequest` | Verify an `ed25519-nkey` request: signature, window, audience, key kinds |
| `model`: `AuthorizationRequestClaims`, `ClientInfo`, `ClientTls`, `ConnectOpts`, `ServerId` | Request claims; secrets redacted in `Debug` |
| `digest::RequestDigest`, `evidence::ExtractedEvidence` | Immutable request identity; what the request carries about the end user |
| `host_client`: `HostDecisionRequest`, `HostDecisionResponse`, `HostEvidence`, `check_echo` | The Host decision contract and its mTLS HTTP client |
| `response`: `ResponseSigner`, `UserGrant` | Signed response and user JWT |
| `xkey`, `bridge::BridgeCore`, `config` | Sealed callouts, the request→decision→response core, the bridge's environment |

Configuration is read from `OPENSESAME_NATS_*`, `OPENSESAME_NATS_CALLOUT_*` and
`OPENSESAME_CALLOUT_TLS_*`; the table is in [`src/config.rs`](src/config.rs).
Every secret is a file path, read once.

## Develop

```bash
cargo +1.88.0 test -p opensesame-nats-callout
cargo +1.88.0 build -p opensesame-nats-callout --bin opensesame-nats-auth-bridge
# Live tests against the pinned nats-server are #[ignore]d
pnpm test:mtls:fixtures
OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-nats-callout -- --ignored
```

The crate is listed in
[`scripts/mtls/mtls-required-packages.txt`](../../scripts/mtls/mtls-required-packages.txt).
Reference `nats-server` configurations, including `secure-callout.conf`, are in
[`ops/nats`](../../ops/nats).

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS and workload identity
- [ADR 0042](../../docs/adr/0042-nats-taskbus-auth-callout-and-xkeys.md) — NATS task bus, auth callout and xkeys
- [`docs/operators/mtls.md`](../../docs/operators/mtls.md)
