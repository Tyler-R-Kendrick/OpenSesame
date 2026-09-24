# opensesame-transport-security

Native TLS for the Host / authority plane: secure listeners, outbound TLS
clients, trust bundles, and the verifiers behind the optional mTLS and
workload-identity profiles. Everything cryptographic is delegated: `rustls`
runs the handshake, `rustls-webpki` builds and validates chains, and
`x509-parser` only reads a leaf that has already been verified. Nothing here
is a TLS stack, a "verify signature only" callback, or a way to turn hostname
checking off.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway),
  [`apps/worker`](../../apps/worker),
  [`opensesame-connection-broker`](../connection-broker),
  [`opensesame-ingress-evidence`](../ingress-evidence),
  [`opensesame-nats-callout`](../nats-callout),
  [`opensesame-provider-openbao`](../provider-openbao),
  [`opensesame-spiffe-source`](../spiffe-source),
  [`opensesame-task-bus`](../task-bus) (optional),
  [`tests/mtls-interop`](../../tests/mtls-interop) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`transport_leaf_parse`).
  [`opensesame-invoke-through`](../invoke-through) uses it for tests only.
- **Builds on:** [`opensesame-domain`](../domain) (`TransportPolicy`, service
  bindings, `VerifiedPeer`, error codes).
- Native only. It is never a dependency of `crates/core`, `crates/client-core`
  or `apps/daemon`; [`tests/dependency_fence.rs`](tests/dependency_fence.rs)
  parses the workspace manifests to keep it that way.
- One rustls provider (`ring`), and every config is built with
  `builder_with_provider`; the crate never sets a process-wide default.

## Surface

| Module | Items |
|---|---|
| `identity` | `TlsIdentity` — a chain plus a key proven to match its leaf; `Debug` never shows the key |
| `trust` | `TrustBundle` — anchors and CRLs used to verify a peer |
| `verify_spiffe` | `SpiffeServerVerifier` — the SPIFFE server-identity profile |
| `client` | `client_config`, `reqwest_builder`, `ClientProfile`, `ServerNamePolicy`, `dial_name` |
| `server`, `listener` | `server_config`, `ServerProfile`, `ListenerLimits`, `DenyThumbprint`, `SecureListener` |
| `generations` | `TransportGenerations`, `GenerationCandidate` — validated whole, then swapped atomically; `withdraw` refuses new and open connections |
| `guard` | `enforce_current_generation` — per-request freshness for keep-alive and HTTP/2 connections |
| `provenance` | `ListenerProvenance`, `PeerExtension`, `ProvenanceLayer` |
| `env` | `TransportEnv` loaders for `OPENSESAME_TLS`, `_MAPPING_TLS`, `_NATS_TLS`, `_WORKER_TLS`, `_CALLOUT_TLS`, `_CONNECTOR_TLS` |
| `leaf`, `error` | `ParsedLeaf`, `LeafUsage`; `classify_tls_error` |

| Cargo feature | Effect |
|---|---|
| `testkit` | Disposable in-memory PKI for tests (`DisposableCa`, `LeafSpec`, `IssuedLeaf`) via `rcgen`. Every knob exists to build a negative fixture. Never enabled by a production binary |

## Develop

```bash
cargo +1.88.0 test -p opensesame-transport-security
pnpm test:mtls              # fast suite; this crate is required
pnpm test:mtls:integration  # pinned nats-server / OpenBao / SPIRE / Caddy fixtures
```

`tests/openssl_oracle.rs` drives `openssl s_client` against the listener as an
independent oracle and fails, not skips, when the binary is missing; the
`*_adversarial.rs` suites cover parsing, identity, bindings and races. Read
[`Cargo.toml`](Cargo.toml) before adding a TLS dependency: a second rustls
provider feature anywhere in the graph breaks provider selection.

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS and workload identity
- [`docs/operators/mtls.md`](../../docs/operators/mtls.md), [`docs/security/mtls-threat-model.md`](../../docs/security/mtls-threat-model.md)
