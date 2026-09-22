# Duress key paths (operator-facing)

No secrets belong in this document. Paths below are inventory and enrollment
guidance for local PWA vaults.

## Independent compartment keys (KEYS-A / INV-05)

- Restricted, decoy, and limited-carry compartments mint their own 32-byte
  roots via `createIndependentCompartmentKey` / `createIndependentNode`.
- Shared vault-root project forks (`createSharedRootNode`) **must not** be
  inventoried as cryptographic isolation. Compilers reject isolation claims
  against shared-root nodes (`assertIndependentIsolation`).

## Wrapper inventory (password / PIN / PRF / legacy / recovery / age / SOPS / cloud)

| Kind | Opens protected root alone? | Isolation claim |
|---|---|---|
| password | yes | never |
| pin | yes (PIN PBKDF2 floor) | never |
| webauthn_prf | yes | never |
| legacy_wrap | yes | never |
| recovery_key | yes | never |
| age | yes | never |
| sops | yes | never |
| cloud_envelope | yes | never |

Use `inventoryWrappers` / `inventoryFromVaultSignals` and surface
`survivingAlternateWrappers` whenever a profile claims two-input crypto or a
hold. Silent bypass is fail-closed (`assertNoSilentBypass`).

## Profile-slot activation (KEYS-B)

- `sealProfileSlot` / `openProfileSlot` bind vaultRef, deviceBindingRef,
  policyRevision, and keyEpoch in AES-GCM AAD.
- Opening a slot does **not** require unlocking the protected shared root.
- Application codes are digit-only, length 8–12 (PIN length floors).

## PRF-and-code envelopes (KEYS-C)

- Outer layer: HKDF-SHA-256 over WebAuthn PRF output.
- Inner layer: PBKDF2-SHA-256 over the application code at the PIN iteration floor.
- Either input alone returns null — both required.
- `sealPrfAndCodeWithDisclosure` returns surviving alternate wrapper warnings.

## Age activation packages

- `sealAgeActivation` / `openAgeActivation` encrypt the compartment key to age
  recipients with purpose-bound framing. No vault-root bootstrap.

## PIN KDF floors (KEYS-D / INV-06)

- Floor: vault `PIN_PBKDF2_ITERATIONS` (1_200_000).
- Ceiling: vault `MAX_PBKDF2_ITERATIONS`.
- Malicious salt size or below-floor iterations throw `DuressKdfError` before
  deriveBits. There is no plaintext code verifier.

## Offline readiness

All of the above run in the browser with WebCrypto and `age-encryption`. No
daemon, Identity, or network is required after enrollment.
