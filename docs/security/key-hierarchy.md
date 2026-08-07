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
