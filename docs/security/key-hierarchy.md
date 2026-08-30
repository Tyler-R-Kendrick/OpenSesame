# Key Hierarchy

## Human E2EE plane
```
VaultRootKey (VRK) 256-bit
  └── ProjectCollectionKey (PCK)
        └── ItemDataKey (IDK) per item version
              └── item ciphertext (XChaCha20-Poly1305)
```

VRK wrappers (client-side only):
- WebAuthn PRF → HKDF-SHA-256 → KEK
- Argon2id(password) → KEK
- Recovery key → KEK
- Device secure-storage KEK

Associated data MUST bind envelope version, item ID, org/project/collection IDs, key IDs, revision.

## Authority plane
- OpenBao transit / KMS / HSM wraps authority blobs
- Receipt signing keys behind authority handle
- Node/service mTLS or SPIFFE SVIDs

## Separation
Valid OIDC session ≠ possession of VRK.

## Certificate and signer key custody (ADR 0066–0072)

Certificate-plane keys are Host-plane authority keys. They never enter the human
E2EE plane above, and no agent surface reaches any of them.

```
Host sealing key (operator-provided; no generated production fallback)
  └── seal_scoped(key, SCOPE, id, organization, plaintext)      XChaCha20-Poly1305
        ├── certificate_authority   CA root / intermediate private keys
        ├── managed_leaf_key        managed-mode leaf keys held for renewal + sync
        ├── certificate_delivery    one-time leaf delivery ciphertext (ADR 0052-cert)
        ├── signer_key              code-signing private keys (sealed custody)
        ├── acme_account_key        upstream ACME account keys
        ├── eab_secret              ACME EAB HMAC (client side and server side)
        ├── est_passphrase          EST enrollment passphrase
        ├── scep_static_secret      SCEP static challenge (stored hashed, then sealed)
        ├── enrollment_secret       other per-method enrollment secrets
        ├── external_ca_credential  external-CA connector credentials
        ├── hsm_pin                 PKCS#11 login PIN
        └── crl_der                 signed CRL DER (integrity + provenance, not confidentiality)
```

Associated data binds organization, record id, record kind, and format version,
exactly as ADR 0052-cert requires. Every sealed carrier is non-`Clone`,
non-`Serialize`, with a redacting `Debug` — the `SealedCertificateMaterial`
pattern in `crates/storage/src/lib.rs`.

### CA root and intermediate keys

A CA's key is either **sealed** (`key_source = 'sealed'`) or **HSM-held**
(`key_source = 'hsm'`, a connector plus a key label). A sealed CA key exists in
gateway process memory at the moment it signs; an HSM-held one never leaves the
token. There is no in-place migration between the two, because migrating sealed
→ HSM would require exporting the key into the token — the operation the design
refuses. An organization that wants a hardware-held root creates one and, if
needed, cross-signs (ADR 0071 §4).

The same key signs issuance, CRLs (ADR 0067 §2) and OCSP responses
(ADR 0067 §6), unless an OCSP-signing delegate issued by that CA and carrying
`id-kp-OCSPSigning` is configured — which lets the CA key stay colder while a
hotter key answers query volume.

Intermediates chain to a parent CA under an enforced path-length constraint.
Externally-signed intermediates keep their key here and export only a CSR; the
signed certificate is imported and validated against the named parent.

### Signer keys

Code-signing keys (`signer_key` scope, or an HSM label) have **no read path of
any kind** — no resolve, no materialize, no export, not even the one-time human
ceremony that leaf certificates get under ADR 0052-cert. The only operation is
"sign this digest", gated by an immutable, scope-pinned, counted access record
(ADR 0070 §1–§4). This is the strictest custody in the repository, and it is
strictest deliberately: a code-signing key that can be exported is one that
eventually will be.

### ACME account keys

Upstream ACME account keys (client side) are sealed under `acme_account_key`, as
ADR 0052-cert established. On the **server** side, OpenSesame holds only account
*public* key thumbprints in `acme_server_accounts` — the enrolling client owns
its account key, and we store nothing that could be used to impersonate it.

### The `Signer` trait keeps custody pluggable

Everything above the key is written against one small trait in `crates/pki-core`
(forthcoming): given a digest and an algorithm, produce a signature; expose the
public key. Two implementations — sealed-key and HSM-key — and **no caller
branches on which it holds**. CA issuance, CRL generation, OCSP responses and
the Sign API all go through it.

This is what makes custody a storage decision rather than a code-path decision.
The rejected alternative, an `if hsm { … } else { … }` at each signing site, is
the version that decays: each new signing site is a new place to forget the
branch, and forgetting it toward "assume sealed" means either a failure or,
worse, silently signing with a key that was supposed to be in hardware.

The asymmetry that follows: sealed keys are covered by ADR 0039's snapshot
backup path; **HSM-held keys can never be backed up by OpenSesame**. Hardware
key ceremony, backup and disaster recovery belong to the operator and their
module.
