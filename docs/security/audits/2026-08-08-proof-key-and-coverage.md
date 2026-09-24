# Audit — proof keys and signature coverage (2026-08-08)

Tick 58. Scope: `crates/proof` — DPoP proof decoding and validation
(`jwk.rs`, `validator.rs`), the replay cache, key custody, and the RFC 9421 HTTP
message signature validator.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | The RFC 9421 validator accepted whatever component set the signer chose — `parse_signature_input` only required the list to be non-empty. A signature covering `@method` alone verified fine, which leaves the body free to change under the same signature and lets the signature travel to a different endpoint. RFC 9421 leaves the required set to the verifier; this verifier required nothing. | `@method`, `@target-uri` and `content-digest` are now all required before a signature is accepted. |
| Medium | A DPoP proof key was accepted at any strength: a 512-bit RSA modulus, or an exponent of 1, bound a token to a key an observer can recover — after which the token's `cnf` claim confirms them. | `assert_proof_key_strength` runs before signature work: RSA needs a 2048-bit modulus (measured after leading zero padding) and an odd exponent above one; OKP must be Ed25519 with a 32-byte public key. |
| Low | `created` on an HTTP message signature was only checked for age, so a future-dated signature outlived its window. | Rejected beyond 60 seconds of skew, matching the DPoP `iat` check. |
| Low | A JWK claiming `kty: OKP` with curve P-256 got a thumbprint computed for it before anything questioned the combination. | Refused as an unsupported algorithm. |

## Not findings

- The DPoP `ath` comparison is exhaustive and fails closed on every mismatched
  pairing, including a proof that carries `ath` when no access token was presented.
- The replay cache is bounded by TTL and capacity and fails closed at capacity
  rather than evicting, which would reopen the window.
- `htu` comparison normalizes through `url::Url`, so default ports and dot
  segments do not create a mismatch, and query and fragment are excluded per
  RFC 9449.
- Key custody generates its own Ed25519 keys and signs only against a
  pre-authorized binding digest; no externally supplied JWK reaches it.

## Notes

- A weak proof key never let an attacker forge a proof directly — the fence is
  that `jkt` must equal the token's confirmation claim, which is a preimage
  problem. What it allowed was binding a token to a key someone else can derive.
- Strength is checked before `DecodingKey::from_jwk`, so a refusal names the key
  rather than a signature failure further down.

## Gates

`cargo test --workspace` (70 suites), `cargo clippy --workspace --all-targets --
-D warnings`, `pnpm test`, `pnpm run typecheck`, task-security-battle-test,
semgrep, ast-grep, osv-scanner, gitleaks, cve-lite — all clean.
