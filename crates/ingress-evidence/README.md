# opensesame-ingress-evidence

RFC 9440 originating-client evidence for the `trusted_ingress` transport
profile on the Host / authority plane. A TLS-terminating proxy can forward the
client certificate it verified in `Client-Cert` and `Client-Cert-Chain`; this
crate turns those fields into an identity only when the request arrived on a
`trusted_ingress` listener, from a peer that is an explicitly bound ingress,
and after the forwarded chain re-validates against the originating-client trust
bundle. Everywhere else the fields are stripped.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway),
  [`tests/mtls-interop`](../../tests/mtls-interop) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`transport_ingress_fields`).
- **Builds on:** [`opensesame-domain`](../domain) (transport contracts,
  `VerifiedPeer`) and [`opensesame-transport-security`](../transport-security)
  (listener provenance, `DenyThumbprint`).
- The origin never saw the client's handshake, so the result is labelled
  `EvidenceSource::TrustedIngressAssertion` and carries the ingress's own
  verified identity beside it.
- Chain building and signature checks are `rustls-webpki`'s job (`verify`);
  `x509-parser` only confirms a byte sequence is one whole DER certificate.
- The parser is mirrored line for line by
  [`@opensesame/ingress-evidence`](../../packages/ingress-evidence); both run the
  JSON corpus in [`fixtures/`](fixtures).

## Surface

| Item | Role |
|---|---|
| `parse_client_cert_fields`, `ForwardedChain`, `has_client_cert_fields` | Bounded RFC 8941 parsing of the two fields |
| `IngressLimits` | Size and count bounds applied while parsing |
| `verify_originating` | Re-validate the forwarded chain against the originating-client trust bundle |
| `IngressAdmission`, `BindingSetAdmission`, `DenyAllIngress` | Decide whether the TLS peer is a bound ingress |
| `originating_peer_layer`, `OriginatingPeerLayer`, `OriginatingPeerExtension` | Tower layer that attaches the verified originating peer to the request |
| `IngressError`, `Field` | Stable error codes, shared with the TypeScript parser |

## Develop

```bash
cargo +1.88.0 test -p opensesame-ingress-evidence
# The Caddy reference-proxy tests are #[ignore]d; fetch the pinned fixtures first
pnpm test:mtls:fixtures
OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-ingress-evidence -- --ignored
```

A change to an error code or a limit changes the shared corpus: update
[`fixtures/`](fixtures) and run the TypeScript mirror's tests too. The crate is
listed in [`scripts/mtls/mtls-required-packages.txt`](../../scripts/mtls/mtls-required-packages.txt),
so `pnpm test:mtls` fails if it disappears.

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS and workload identity
- [`docs/operators/mtls.md`](../../docs/operators/mtls.md), [`ops/ingress`](../../ops/ingress) (the Caddy reference)
