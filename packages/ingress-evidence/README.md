# @opensesame/ingress-evidence

RFC 9440 originating-client evidence for the Identity plane. Two entries:

| Entry | Runs in | Exports |
|---|---|---|
| `@opensesame/ingress-evidence` | browser or Node (no native imports) | `parseClientCertFields`, `hasClientCertFields`, `stripClientCertFields`, `pairsFromRawHeaders`, `IngressEvidenceError`, `DEFAULT_INGRESS_LIMITS` |
| `@opensesame/ingress-evidence/node` | Node only (`node:crypto`) | `verifyOriginatingChain`, `OriginatingChainError` |

The parser is a line-for-line twin of `crates/ingress-evidence`
(`opensesame-ingress-evidence`). Both run the corpus under
`crates/ingress-evidence/fixtures/`, so every error code below means the same
thing in both planes.

## What a header proves

Nothing. A certificate is public. `parseClientCertFields` returns a
`ForwardedChain` that is **untrusted input**; `verifyOriginatingChain` then
checks that it chains to the originating-client trust bundle, is valid at
`now`, and permits client authentication. That constrains what the origin will
accept but cannot recreate the ingress's handshake: proof of possession
happened there. So the result may only be used when the request arrived on a
`trusted_ingress` listener from an ingress that is itself authenticated and
explicitly bound (`BindingPurpose.TrustedIngress`), and it must be labelled
`trusted_ingress_assertion` — never `direct_tls`. On any other listener,
strip the fields (`stripClientCertFields`) and attach nothing.

## Parsing

```ts
import { parseClientCertFields, pairsFromRawHeaders, IngressEvidenceError } from "@opensesame/ingress-evidence";

try {
  const chain = parseClientCertFields(pairsFromRawHeaders(req.rawHeaders));
  // chain.leafDer, chain.intermediatesDer, chain.leafThumbprintSha256
} catch (err) {
  if (err instanceof IngressEvidenceError) reject(err.code); // never the header text
}
```

Pass **physical** header fields. `Client-Cert` is a singleton (RFC 9440 §2.2)
and a repeat is `leaf_repeated`; `Client-Cert-Chain` is a List that may be
split across fields (§2.3) and the lists are concatenated in wire order. A
fetch `Headers` object has already joined repeats with `, `, which makes a
repeated leaf `malformed_structured_field` instead — still refused.

Limits (`DEFAULT_INGRESS_LIMITS`): 64 KiB of undecoded header text, 16 KiB per
decoded certificate, 8 chain certificates. Parser work is linear in the header
bytes. Checks run in a fixed order and the first failure is the code:

| Code | Meaning |
|---|---|
| `header_bytes_exceeded` | total undecoded `Client-Cert*` text over the limit |
| `leaf_missing` | no `Client-Cert` (including a chain without a leaf) |
| `leaf_repeated` | more than one physical `Client-Cert` field |
| `malformed_structured_field` | not RFC 8941 syntax of the required type, or non-canonical base64 (unpadded, stray pad bits) |
| `not_byte_sequence` | a String, Token, Integer, Boolean or Inner List where a Byte Sequence is required |
| `parameters_present` | an item carries parameters |
| `empty_item` | a zero-length byte sequence, or a field value with no members |
| `certificate_too_large` | a decoded certificate over the limit (checked before DER) |
| `chain_too_long` | more chain members than the limit |
| `not_der_certificate` | a byte sequence is not exactly one DER certificate |
| `conflicting_leaf` | the leaf is a CA, the chain holds another end-entity certificate, or a copy of the leaf anywhere but position zero |

A leading chain member byte-identical to the leaf is dropped (some proxies
repeat it); RFC 9440 says the chain excludes the leaf.

## Verifying (Node only)

```ts
import { verifyOriginatingChain, OriginatingChainError } from "@opensesame/ingress-evidence/node";

const verified = verifyOriginatingChain(chain, originatingTrustPem, new Date());
// verified.selectors: [{kind:"dns_name"|"spiffe_id"|"uri_san"|"leaf_thumbprint_sha256", value}]
// verified.notBefore / notAfter / leafThumbprintSha256 / pathLength
```

Path building uses `X509Certificate.checkIssued` + `verify(issuerPublicKey)`
against the anchors in `originatingTrustPem` (`OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`),
then the forwarded intermediates, bounded to eight. Every certificate on the
path must be inside its window at `now`; the leaf must carry
`extendedKeyUsage` including `clientAuth` and must not be a CA. Errors are
`OriginatingChainError` with a `TransportError` code: `trust_unknown`,
`evidence_expired`, `forwarded_evidence_unverified`, `malformed_configuration`.
CRLs are not consulted here; the Rust origin checks them.

Selectors are exact-match only: lowercase DNS SANs without wildcards, URI SANs
(`spiffe://` ones as `spiffe_id`), and always the leaf thumbprint last. Map
them onto `PeerIdentitySelector` from `@opensesame/os-domain` when binding.

## Tests

`pnpm --filter @opensesame/ingress-evidence test` runs the shared corpus and a
verifier suite that builds a disposable PKI with the `openssl` CLI in a temp
directory (an oracle independent of Node) and deletes it afterwards.
