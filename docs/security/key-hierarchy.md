# Key Hierarchy

## Human E2EE plane

Two key trees share one root-protection model, the any-of protector manifest of
[ADR 0129](../adr/0129-vault-key-protection-manifest.md).

The Pages vault (`packages/vault-core`,
[vault format v1](../architecture/vault-format-v1.md)):
```
Vault key (VK) 256-bit, one per vault
  └── vault body and sealed header fields (AES-256-GCM, random 12-byte IV)
```

The native envelopes (`crates/human-vault`, `crates/sealed-store`):
```
VaultRootKey (VRK) 256-bit
  └── ItemDataKey (IDK) — the same 32 bytes as the VRK (`ItemDataKey(vrk.0)`)
        ├── item ciphertext (XChaCha20-Poly1305)
        └── attachment key: HKDF-SHA-256(IDK, attachment id), one per attachment
```

There is no separate project or collection key and no per-item subkey in the
code: an item is bound to its context through associated data, not through a
key of its own.

Root wrappers (client-side only). Each is a protector in the ADR 0129 manifest
(`ProtectorKind` in `packages/vault-core/src/protection-types.ts`):
- WebAuthn PRF → HKDF-SHA-256 → KEK
- Password: PBKDF2-HMAC-SHA-256 (at least 600,000 iterations) → master key in
  the Pages vault; Argon2id → HKDF-SHA-256 → KEK in the native envelopes. A new
  vault is sealed by passkey, not password (ADR 0180); an existing password
  wrap stays.
- PIN → PBKDF2-HMAC-SHA-256 → KEK (Pages vault)
- Recovery key (32 random bytes) → HKDF-SHA-256 → KEK
- Device-local, age recipient, age passkey, YubiKey PIV age, and cloud KMS
  (AWS, Azure Key Vault, GCP) protectors

Native envelope associated data binds envelope version, item ID,
org/project/collection IDs, key ID and revision (`AssociatedData` in
`crates/human-vault`).

## Authority plane
- Authority values at rest are sealed under the Host sealing root (below).
  OpenBao is a `CredentialAuthority` provider (KV and leases); nothing in this
  tree calls its transit engine to wrap authority blobs.
- Receipt signing key: an Ed25519 seed from `OPENSESAME_RECEIPT_SIGNING_KEY`
  (a production or networked Host refuses to start without it; local development
  falls back to an ephemeral key); retired verification keys come from
  `OPENSESAME_RECEIPT_VERIFY_KEYS`
- Node/service mTLS or SPIFFE SVIDs (software custody; ADR 0132)

## Separation
Valid OIDC session ≠ possession of the vault key.

## Certificate and signer key custody (ADR 0066–0072)

Certificate-plane keys are Host-plane authority keys. They never enter the human
E2EE plane above, and no agent surface reaches any of them.

```
Host sealing root (OPENSESAME_CONNECTION_KEY; operator-provided, no derived or generated fallback)
  └── HKDF(context: organization, purpose, record) → wrapping key
        └── wrapped random data key → XChaCha20-Poly1305 ciphertext
              seal_scoped(key, SCOPE, id, organization, plaintext)
        scopes written by the gateway today:
        ├── certificate_authority   CA root / intermediate private keys, and upstream ACME account credentials (stored as an authority row)
        ├── managed_leaf_key        managed-mode leaf keys held for renewal
        ├── certificate_delivery    one-time leaf delivery ciphertext (ADR 0052-cert)
        └── est_passphrase          EST enrollment passphrase
        scopes declared in `crates/storage` (`seal_scopes`) with no writer outside a storage test in this tree:
        enrollment_secret, eab_secret, scep_static_secret, signer_key, hsm_pin,
        external_ca_credential, crl_der, acme_account_key
```

Associated data binds organization, record id, record kind, and format version,
exactly as ADR 0052-cert requires. Every sealed carrier is non-`Clone`,
non-`Serialize`, with a redacting `Debug` — the `SealedCertificateMaterial`
pattern in `crates/storage/src/lib.rs`.

New authority values use a fresh random data key per write. The root-derived
wrapping key and both encryption layers authenticate a canonical length-framed
context. Legacy direct seals remain readable. These wrapping keys separate
customers while retaining one operator root; they do not establish independent
customer KMS custody. Human vaults retain independent random roots. See
[customer key segmentation](../operators/customer-key-segmentation.md) for the
storage coverage and upgrade contract.

### CA root and intermediate keys

A CA's key is sealed in the tree today (`key_source = 'sealed'`). The schema and
the CA signing-config route (`/api/v1/certmgr/cas/{id}/signing-config`) also
accept `key_source = 'hsm'` (a connector plus a key label), but no HSM connector
or signer exists in this tree (ADR 0071 is a design; there is no PKCS#11
client), so an `hsm` authority has nothing that can sign for it. Under the ADR 0071 design an HSM-held key never leaves the
token, and there is no in-place migration between the two, because migrating
sealed → HSM would require exporting the key into the token — the operation the
design refuses. An organization that wants a hardware-held root creates one and,
if needed, cross-signs (ADR 0071 §4).

A sealed CA key exists in gateway process memory at the moment it signs. The CRL
and OCSP builders in `crates/pki-core` sign with whatever key they are handed:
the CA key, or an OCSP signing delegate's, which lets the CA key stay colder
while a hotter key answers query volume (ADR 0067 §2, §6). They do not check
that a delegate was issued by that CA or carries `id-kp-OCSPSigning`; ADR 0067
§6 puts that check at configuration time and no configuration path exists. No
gateway route calls them yet.

Intermediates chain to a parent CA under an enforced path-length constraint.
Externally-signed intermediates keep their key here and export only a CSR; the
signed certificate is imported and validated against the named parent.

### Signer keys

Code-signing (ADR 0070) is a design with persistence only: the `signers`,
membership and signing-access tables exist in `crates/storage`, and the
`signer_key` scope is declared, but no gateway route creates a code-signing
signer or signs with one (the lifecycle scanner only reads their expiry).
The design gives these keys **no read path of any kind** — no resolve, no
materialize, no export, not even the one-time human ceremony that leaf
certificates get under ADR 0052-cert. The only operation would be "sign this
digest", gated by an immutable, scope-pinned, counted access record (ADR 0070
§1–§4). That is the strictest custody the repository describes, and it is
strictest deliberately: a code-signing key that can be exported is one that
eventually will be.

### ACME account keys

Upstream ACME account keys (client side) are sealed with the authority rows, as
ADR 0052-cert established. ACME is not served (`crates/storage/src/acme.rs`
holds persistence only), but its schema is shaped for the server side: it
stores account *public* key thumbprints in `acme_server_accounts` — the
enrolling client would own its account key, and nothing is stored that could be
used to impersonate it.

### The `Signer` trait keeps custody pluggable

`crates/pki-core` defines one small trait, `Signer`: given a message, produce a
signature; expose the algorithm and public key. Its only implementation today is
`SealedKeySigner`, which signs OCSP responses; CA issuance and CRL building take
the CA's `KeyPair` directly, and the HSM implementation the design calls for
does not exist. The intent (ADR 0071) is that custody becomes a storage
decision rather than a code-path decision: the rejected alternative, an
`if hsm { … } else { … }` at each signing site, is the version that decays, since
each new signing site is a new place to forget the branch, and forgetting it
toward "assume sealed" means either a failure or, worse, silently signing with a
key that was supposed to be in hardware.

The asymmetry that follows from the design: sealed keys are covered by ADR
0039's snapshot backup path; **HSM-held keys can never be backed up by
OpenSesame**. Hardware key ceremony, backup and disaster recovery belong to the
operator and their module.
