# Architecture Overview

```
Clients (CLI, extension, SDK, MCP, PWA, toolbar)
        │  HTTPS / DPoP / local daemon (UDS) / optional mTLS (ADR 0130)
        ▼
┌───────────────────────┐     ┌──────────────────────────┐
│ Identity API (:8788)  │     │ Host API gateway (:8787) │
│ control-plane (TS)    │     │ uses host-core (Rust)    │
└───────────────────────┘     └────────────┬─────────────┘
                                           │
                              Policy PEP + Broker (host-core)
                                   ┌───────┴───────┐
                                   ▼               ▼
                            E2EE client-core   Authority adapters
                            (local sync)       (OpenBao / OpenFGA / WASM)
```

**APIs stay separate** (ADR 0017). Polyglot cores share WIT contracts.

- Host/client topology: `docs/architecture/host-client-topology.md`
- Identity plane: `docs/architecture/identity-plane.md`
- Availability classes A0–A3: ADR 0003
- ConnectionRef over SecretRef: ADR 0005
- In-product contextual support and GuideLang: `docs/architecture/ai-contextual-support.md`, ADR 0087

## Transport security (ADR 0130)

The planes above talk to each other over hops that are each declared, never
inferred. A hop is one of `existing_local` (loopback, Unix socket with kernel
peer credentials, operator token — the profile every single-host deployment
runs), `server_tls`, `mtls_required`, or `trusted_ingress`. None is a fallback
for another: an `mtls_required` hop that cannot load its material refuses to
start, and the static PWA needs none of them.

```text
browser ──TLS──▶ ingress (Caddy ref, ops/ingress) ──mTLS, bound peer──▶ Host / Identity
                 RFC 9440 Client-Cert forwarded          trusted_ingress listener only

Host ──mTLS──▶ Identity   principals.mapping.resolve only (OPENSESAME_MAPPING_AUTH=mtls)
Host ──mTLS──▶ worker     worker.providers.list / worker.health.ready
Host / worker / bridge ──TLS-first + client cert + NKey──▶ NATS  (client connections only)
NATS ──$SYS.REQ.USER.AUTH──▶ opensesame-nats-auth-bridge ──mTLS──▶ Host  nats.callout.decide
Host ──ConnectionRef-scoped mTLS──▶ OpenBao auth/cert, private HTTPS upstreams
```

What a certificate proves at each hop is possession of a key that chains to
the trust profile the operator installed. What it does **not** prove is
authority: the verified peer (`VerifiedPeer`, constructed only by the TLS
verifiers and never from a header or body) is resolved to exactly one
operator-written service binding, and the operation is then authorized by the
same PEPs, grants and ConnectionRef checks as before. Identity sources are PEM
files, an ADR 0075 managed certificate (Host-sealed, exportable to the Host
process), or a SPIFFE Workload API SVID (key delivered to the workload;
process-level granularity). The daemon keeps its serde + std budget and gains
no TLS; browser packages carry only the pure TypeScript mirror of the
contracts. Two TLS hops through an ingress are two hops, not one session.

- Operator reference: `docs/operators/mtls.md`
- Trust boundaries and abuse cases: `docs/security/mtls-threat-model.md`
- Executed evidence: `docs/validation/mtls-implementation.md`
