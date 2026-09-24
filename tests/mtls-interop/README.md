# opensesame-mtls-interop

Cross-runtime interoperability oracles for optional mTLS and workload identity
([ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)). Each
test drives an entry point that already ships — the Rust `SecureListener`, the
`opensesame-gateway` process, the Identity plane's Node TLS listener — from a
runtime that did not build it, and checks it refuses what policy says it must.
The crate holds no production code, and nothing that ships depends on it.

## Where it fits

- **Run by:** `pnpm test:mtls:integration`
  ([`scripts/mtls/mtls-integration-test.sh`](../../scripts/mtls/mtls-integration-test.sh)),
  as its `it-mtls-interop` step. The crate is a Cargo workspace member but is
  commented out of `scripts/mtls/mtls-required-packages.txt`, so today that
  step is not required.
- **Builds on:** `opensesame-transport-security` (without its `testkit`
  feature), `opensesame-domain` (`ServiceBindingSet`, so a handshake refusal is
  told apart from a post-handshake authorization denial) and
  `opensesame-ingress-evidence`.
- Every certificate is minted by the system `openssl` CLI into a temporary
  directory, never by the `rcgen` testkit the production verifiers were built
  against. Every child process is bounded and killed with its process group.
- A pass shows a certificate was refused by independent stacks. It says
  nothing about a deployment's real trust configuration.

## Surface

| Test | Pairing |
|---|---|
| `iop_tls_rust_listener` | `SecureListener` on `MtlsRequired`, dialled by `openssl s_client`: key possession, server identity, client identity and application permission asserted separately |
| `iop_tls_node_client` | Node's OpenSSL as client, the Rust listener as server |
| `iop_tls_identity_listener` | `apps/control-plane/src/transport/listener.ts` under `tsx`, dialled by a Rust client |
| `iop_tls_gateway_process` | The real `opensesame-gateway` binary, configured as an operator would |
| `iop_tls_evidence` | An accepted TLS session is not peer evidence on a `server_tls` listener |
| `iop_nats` | The pinned `nats-server`: the production Rust client publishes, `openssl s_client` consumes; reconnects re-derive authority |
| `iop_openbao` | A TLS-enabled OpenBao with `auth/cert`, driven by `curl` |
| `iop_spiffe` | A real SPIRE deployment, with federated-bundle removal as the subject |
| `iop_ingress` | The shipped `ops/ingress/Caddyfile` in front of the origin, with two clients over one pooled connection |

`src/` holds the shared parts: `pki/` (the OpenSSL-issued PKI), `oracle.rs`
(`s_client`), `node.rs` (runs the Node scripts in `harness/`), `proc.rs`
(bounded children, kernel-allocated ports). `harness/browser-cert-endpoint.mjs`
also serves `apps/pages/scripts/verify-browser-cert.mjs` in
`pnpm test:mtls:browser`.

## Develop

```bash
pnpm test:mtls:integration       # fetch and verify fixtures, start servers, run every ignored mTLS suite
pnpm test:mtls:fixtures          # fetch and sha256-verify nats-server, OpenBao, SPIRE, Caddy only
OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-mtls-interop -- --ignored
```

Every test is `#[ignore]`d unless run with `--ignored` and
`OPENSESAME_MTLS_FIXTURES=1`. Native binaries come from
`scripts/mtls/mtls-fixtures.sh path <tool>`, which checks a sha256 pin first;
the integration script exports `OPENSESAME_MTLS_BIN_*` for the ones it has
already verified. Fixtures land in `.cache/mtls-fixtures/` (Linux x86_64 or
aarch64 only). The tests also need `openssl`, `curl`, `node` and `tsx`. A
missing fixture is a failure, never a skip.

## Related

- [`docs/operators/mtls.md`](../../docs/operators/mtls.md) — operator reference for optional mTLS
- [`docs/validation/mtls-implementation.md`](../../docs/validation/mtls-implementation.md) — implementation evidence
- [`crates/transport-security`](../../crates/transport-security) — the listener and verifiers under test
