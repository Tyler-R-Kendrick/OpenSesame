# Transport topology

How the Host, Identity API, worker, NATS and upstreams reach one another, and
what each hop's authentication proves
([ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md)). The system
as a whole is described in the [architecture overview](README.md).

The planes talk to each other over hops that are each declared, never
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
