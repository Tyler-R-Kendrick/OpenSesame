# opensesame-pki-core

The provider-agnostic X.509 engine behind the Host certificate manager. It is a
pure library with no HTTP surface, no database and no `axum`: everything the
certificate-manager routes, the ACME/EST/SCEP servers and the renewal actor
need to make or read certificate material lives here, so each rule has one
implementation, one set of bounds and one error taxonomy.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) (the `certmgr_*` and `est_*`
  routes, and transport-certificate minting, issuance and CRLs in
  `src/transport_lifecycle`) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`pki_crl_parse`, `pki_csr_parse`,
  `pki_ocsp_request_parse`, `pki_pkcs12_parse`).
- **Builds on:** no workspace crates. `rcgen`, `x509-parser`, the RustCrypto
  `der` 0.7 generation (`x509-cert`, `spki`, `pkcs8`, `p256`, `p384`, `rsa`),
  `ed25519-dalek` and `p12-keystore`. [`Cargo.toml`](Cargo.toml) records why each
  pin was chosen.
- Secrecy invariant: private material is carried only by `keys::KeyPair`,
  `ca::GeneratedCa`, `signer::SealedKeySigner` and `bundle::Pkcs12Entry`. None
  implements `Clone` or `Serialize`, all redact `Debug`, and no `PkiError`
  interpolates secret bytes. The one private-material accessor is
  `KeyPair::private_key_pkcs8_pem`, which returns a zeroizing string.

## Surface

| Module | Responsibility |
|---|---|
| `types` | Serde documents shared with storage and the API (`PolicyRules`, `ProfileDefaults`, `SanEntry`, `SubjectDn`, key and signature algorithms) |
| `keys` | Key-pair generation and PKCS#8 encoding |
| `signer` | The custody-agnostic `Signer` trait and `SealedKeySigner` |
| `ca` | Root and intermediate authority generation and validation |
| `csr` | Bounded CSR parsing and generation |
| `leaf` | End-entity issuance |
| `policy` | The three-state policy evaluator and its presets (`PolicyCandidate`, `PolicyViolation`) |
| `revocation` | CRL and OCSP construction and parsing |
| `bundle` | Chain normalization, PKCS#12, fingerprints |
| `pkcs7` | PKCS#7 `certs-only` encoding and strict decoding for EST |

## Develop

```bash
cargo +1.88.0 test -p opensesame-pki-core
```

The `pact` tests pin wire shapes as `insta` snapshots in
[`src/snapshots`](src/snapshots); a changed snapshot is a changed contract with
storage and the API. `policy.rs`, `revocation.rs` and `bundle.rs` are in the
Rust mutation scope (`pnpm test:mutation:rust`).

## Related

- [ADR 0066](../../docs/adr/0066-certificate-manager-domain-model.md) — certificate manager domain model
- [ADR 0067](../../docs/adr/0067-certificate-revocation-crl-ocsp.md) — revocation, CRL and OCSP
- [ADR 0071](../../docs/adr/0071-hsm-connectors.md) — HSM connectors
- [`docs/validation/certificate-manager.md`](../../docs/validation/certificate-manager.md)
