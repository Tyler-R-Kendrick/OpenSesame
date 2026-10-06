# RSA Marvin advisory reachability — October 6, 2026

The unconfigured cargo-audit scan reports RUSTSEC-2023-0071 / CVE-2023-49092 in
`rsa` 0.9.10. The live RustSec advisory has no patched version and explicitly
states that both 0.9.10 and 0.10.0-rc.18 remain affected as of September 12, 2026.
It recommends avoiding deployments where attackers can observe operation timing.
The historical August 7 exception ID and scope are unchanged. Its explanation
now points to this current assessment instead of the obsolete SQLx-only rationale.

## What the current source establishes

The dependency is no longer only a SQLx lockfile edge: `opensesame-pki-core`
depends directly on `rsa`. Its `SealedKeySigner` RSA/SHA-256, SHA-384 and SHA-512
branches call `rsa::pkcs1v15::SigningKey::try_sign`. In rsa 0.9.10, that method
passes **no RNG** to the signature implementation, which calls
`rsa_decrypt_and_check` and then `rsa_decrypt`. The latter performs unblinded,
variable-time CRT `BigUint::modpow` operations. The internal function name
`rsa_decrypt` denotes the private RSA primitive here; it does not mean an
application ciphertext-decryption endpoint was found.

Therefore signing is not declared unaffected just because no private decryption
API is exposed. The advisory describes private-key timing leakage broadly.
This review did not demonstrate key recovery or a specific Marvin exploit
against signatures; a classic chosen-ciphertext/padding-oracle attack and
chosen-message signing are different attack surfaces.

Current caller inspection found:

| Path | Operation and deployment assessment |
| --- | --- |
| `pki-core/src/signer.rs:137` | Exported local library RSA signing API, using the variable-time private primitive described above. |
| `pki-core/src/revocation.rs:526` | `build_ocsp_response` creates that signer and signs response data. Its references outside this module are tests; no gateway OCSP responder route or production caller was found in the workspace. A downstream service embedding this API remains a possible exposure. |
| `pki-core/src/ca.rs:158`, `leaf.rs:243` | Certificate issuance uses `key.rcgen()` and rcgen's signing backend, rather than `SealedKeySigner`. Gateway CA/EST issuance imports these key pairs. |
| `pki-core/src/revocation.rs:123` | The library CRL builder also calls rcgen; gateway inspection did not find a production call to this builder. |
| rcgen 0.13.2 | The resolved default backend is `ring`; RSA signing calls its `RsaKeyPair::sign` with `SystemRandom`. This is a different implementation from the flagged RustCrypto signer. |
| `pki-core/src/keys.rs:104` | Fresh RSA key generation uses RustCrypto, then imports PKCS#8 into rcgen. Timing a new key generation is not the identified repeated private-operation oracle over a retained key. Local/co-resident threats were not experimentally evaluated. |
| `sqlx-mysql` 0.8.6 `connection/auth.rs:166` | Uses a server public key for OAEP encryption, with no client's RSA private operation. Workspace SQLx configuration enables SQLite/Postgres, not MySQL; the lock inventory alone does not establish this driver is deployed. |

Searching application/crate Rust sources found no use of RustCrypto RSA
private-key ciphertext decryption. Generic `.decrypt` calls elsewhere operate
on symmetric AEAD or explicitly use AWS-LC RSA in test fixtures; they were not
treated as evidence of a RustCrypto decryption endpoint.

The `Signer` module comment says certificate/CRL/OCSP operations all use its
trait, but actual certificate and CRL source currently uses rcgen directly.
The source call sites, not that broad comment, determine this assessment.

## Deployment decision and maintained options

Do not publish the current RustCrypto-backed RSA `SealedKeySigner` or RSA OCSP
response builder as an attacker-timable service on the basis of the older
SQLx-only exception. A deployment that adds such a caller must first use a
maintained RSA backend for the private operation, or select a supported
ECDSA/Ed25519 responder key. Authentication or request limits do not establish
constant-time private arithmetic.

An adapter using `ring`'s maintained RSA signing API is compatible with the
backend already used by current certificate issuance. AWS-LC is another
maintained backend already present in this workspace. Either change needs
cross-algorithm PKCS#8 import/signature verification tests and caller review;
no backend migration or handwritten crypto was introduced for the retired-trap
feature. Switching only to RustCrypto's randomized signing method is not
presented as a patched-release fix: RustSec still lists no patched version.

A SQLx upgrade alone would not eliminate the direct PKI dependency. Removing
the audit exception requires addressing both actual dependency edges and
repeating an unconfigured scan. The configured gate currently passes while
the unconfigured inventory reports one known issue; neither a feature test nor
this source review is a formal timing proof.

Sources:

- https://rustsec.org/advisories/RUSTSEC-2023-0071.html
- https://github.com/RustCrypto/RSA/issues/626
- https://github.com/RustCrypto/RSA/security/advisories/GHSA-c38w-74pg-36hr
- https://github.com/RustCrypto/RSA/pull/680
- https://github.com/RustCrypto/RSA/pull/702

Private raw scan: `/tmp/opensesame-audit.tdKBv56h/cargo-audit-unconfigured.json`.
