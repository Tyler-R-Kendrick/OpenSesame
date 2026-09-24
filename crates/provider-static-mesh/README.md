# opensesame-provider-static-mesh

A static service-discovery adapter for tests and Headscale-oriented
deployments. It answers "which endpoints advertise service `x`?" from a
mutex-protected in-memory map. It is not a transport: it opens no socket, holds
no certificate or key, verifies no peer, and offers no TLS or mTLS guarantee.

## Where it fits

- **Used by:** no workspace crate, app or fuzz target depends on it today. Its
  only callers are its own unit tests in [`src/lib.rs`](src/lib.rs).
- **Builds on:** no workspace crates (`async-trait`, `serde`, `thiserror`).
- Discovery and transport are separate. An address it returns is a string the
  caller dials through its own transport policy
  ([`opensesame-transport-security`](../transport-security) for native TLS,
  `existing_local` for loopback or UDS); resolving a name proves nothing about
  who answers there.
- Earlier wording called this an "mTLS mesh adapter". ADR 0132 corrected the
  description without adding any transport behaviour.

## Surface

| Item | Role |
|---|---|
| `MeshProvider` | `current_node`, `peers`, `advertise`, `withdraw`, `resolve` |
| `StaticMesh` | Single-node implementation: `peers()` is always empty, `current_node()` carries no credential material |
| `MeshService`, `MeshEndpoint`, `MeshNodeIdentity`, `MeshPeer`, `DevicePosture` | Value types |
| `MeshError` | Error type |

`advertise` refuses a service id that is empty or contains `..`, `/`, `\` or a
NUL byte. Resolving an unknown service returns an empty list.

## Develop

```bash
cargo +1.88.0 test -p opensesame-provider-static-mesh
```

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS and workload identity (the correction)
- [ADR 0002](../../docs/adr/0002-foundations.md) — foundations (Tailscale and static mesh adapters)
