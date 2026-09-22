# ADR 0129 — Vault key protection manifest (any-of roots)

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** OpenSesame maintainers

## Context

Settings → Connections → Encryption mixed a browser crypto API, file formats,
authenticator protocols, hardware brands, and cloud KMS into one “encryption
provider” preference. That preference could not answer: which independently
usable keys unlock *this* vault, where those keys are controlled, and what was
tested. Browser vaults already supported password / PIN / WebAuthn-PRF wraps of
one root (`VaultHeader.unlocks`). Native sealed-store used `.opensesame-key`
with the root bytes also acting as the content key on some paths.

## Decision

1. **Three layers:** vault key protection (manifest), connections (auth to
   providers/devices), formats/interop (native / age / SOPS / GPG). Backup remotes
   are not root protectors.
2. **Extend existing unlocks.** The versioned `RootProtectionManifest` is the
   authority for enrolled protectors. It may live on `VaultHeader.protection`
   (browser) or `.opensesame-key` (native). Do not create a second global
   `wrappedKeys[]` beside `VaultHeader.unlocks`. Legacy wraps remain readable and
   are projected into the manifest on migration without changing derivation
   domains (including `opensesame/vault/webauthn-prf/v1`).
3. **Any-of semantics.** Each enrolled usable protector is an independent path to
   the same root. Listing multiple methods is not MFA.
4. **Authenticated metadata.** Wrappers bind immutable `ProtectionContext`
   (vaultId, rootKeyId, rootEpoch, protectorId, purpose). Mutable manifest
   `revision` is MAC’d with the manifest, not put in every wrapper AAD.
5. **Cloud protectors.** Client mints a 32-byte wrapping secret; local HKDF KEK
   seals the root capsule; KMS only encrypts the 32-byte secret. KMS decrypt
   rights plus the envelope remain an independent recovery path — disclosed,
   not marketed as zero-knowledge.
6. **Trusted client boundary.** Human-root material stays in the browser and/or
   an explicitly paired personal native client. No clear wrapping-secret proxy.
   Agents/ConnectionRef must not gain human-root unwrap oracles.
7. **SOPS.** *Superseded by [ADR 0130](0130-browser-local-sops.md).* This
   decision was right and, at the time, unimplemented: SOPS YAML/JSON was
   "not available in-browser" and the person was pointed at a native binary
   via `OPENSESAME_SOPS_BIN`, which the static deployment cannot reach. The
   partial engine that replaced that wording still had no way to open a SOPS
   document. A 2026-09-21 amendment here (evidence in
   `docs/evidence/2026-09-21-sops-browser/`) called that engine "complete and
   machine-checked"; it was ahead of the code, and ADR 0130 replaces both this
   clause and that amendment with an implemented, oracle-verified engine and a
   reachable document workflow. Two divergences that amendment recorded no
   longer apply: the engine emits no `opensesame` origin field, and
   `shamir_threshold` only above one group, which is upstream's own rule.
   SOPS remains a document format, not a vault root protector, and threshold
   key-groups are still preserved or refused — never silently flattened to
   any-of.
8. **`capabilityConnectors.encryption`.** Legacy setup preference / migration
   hint only. Never overrides cryptographic enrollment facts.

## Consequences

- UI: Settings → Security → Vault key protection is the authority view;
  Connections offer “use this connection to protect a vault key.”
- Compromise rotation must rewrite content where the root is the content key
  (`ItemDataKey(vrk.0)` paths); rewrap alone is not revocation of historical
  ciphertext.
- Live AWS/Azure/GCP/PIV proofs are opt-in and may be `blocked` without failing
  the deterministic local gate (`pnpm verify:key-protection`).
- Mixed-client: older clients ignore unknown fields; new clients reject unknown
  *critical* manifest versions. `minReaderVersion` cannot force already-shipped
  clients.

## References

- C01–C13 product contracts in the implementation workstream
- ADR 0037 (git sealed store), ADR 0090 / 0128 (Pages without Host)
- Evidence: `docs/evidence/2026-09-20-vault-key-protection/`
