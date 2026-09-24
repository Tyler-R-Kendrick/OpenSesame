# opensesame-proof

RFC 9449 DPoP validation and constrained proof-key custody for the Host /
authority plane. It validates a presented DPoP proof (`typ`, `alg`, `jti`,
`htm`, `htu`, `iat`, optional `ath`, replay via `jti`) and checks it against
the access token's `cnf.jkt`. Its key custody signs proofs only for requests
that were explicitly authorized, so custody is never a general signing oracle. It also carries a narrow RFC 9421
HTTP Message Signatures subset.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`jwt_jwk`, `uri_normalize`,
  `replay_cache`).
- **Builds on:** [`opensesame-domain`](../domain); `jsonwebtoken` for JWS.
- A DPoP-bound token presented as a bearer is refused
  (`reject_dpop_bound_as_bearer`, `assert_token_presentation`).
- The HTTP Message Signatures module covers `@method`, `@target-uri` and
  `content-digest` with Ed25519 only; it does not claim full RFC 9421
  interoperability.

## Surface

| Module | Items |
|---|---|
| `validator` | `DpopValidator`, `ValidatedDpopProof`, `DpopAdvertisement`, `reject_dpop_bound_as_bearer`, `assert_token_presentation` |
| `jwk` | `decode_dpop_proof`, `sign_dpop_proof`, `jwk_thumbprint`, `access_token_hash`, `normalize_htu`, `assert_proof_key_strength`, `DPOP_TYP`, `DPOP_MAX_FUTURE_SKEW_SECS`, `MIN_RSA_MODULUS_BITS` |
| `replay` | `ReplayCache`, `InMemoryReplayCache`, `DEFAULT_REPLAY_TTL_SECS`, `DEFAULT_REPLAY_CAPACITY`, `MAX_JTI_LEN` |
| `custody` | `KeyCustodyProvider`, `LocalSoftwareKeyCustodyProvider`, `AuthorizedProofRequest` |
| `http_message_signature` | `HttpMessageSignatureValidator`, `LocalHttpMessageSignatureValidator`, `sign_request`, `content_digest_sha256`, `REQUIRED_COVERED_COMPONENTS` |
| `error` | `ProofError` |

| Cargo feature | Effect |
|---|---|
| `concurrency-test` | Pulls in `shuttle` and enables the `shuttle_replay` test |

## Develop

```bash
cargo +1.88.0 test -p opensesame-proof
pnpm audit:shuttle   # includes the shuttle_replay model check
pnpm audit:miri      # includes the replay cache unit tests under Miri
pnpm test:task-access
```

`tests/browser_es256.rs` runs `node` with
[`tests/browser_es256_fixture.mjs`](tests/browser_es256_fixture.mjs) to sign a
proof with WebCrypto, independent of the Rust validator's crypto.

## Related

- [ADR 0022](../../docs/adr/0022-proof-custody.md) — proof custody
- [ADR 0023](../../docs/adr/0023-mcp-bearer-vs-dpop.md) — MCP bearer vs DPoP
- [`docs/security/audits/2026-08-08-dpop-token-binding.md`](../../docs/security/audits/2026-08-08-dpop-token-binding.md)
