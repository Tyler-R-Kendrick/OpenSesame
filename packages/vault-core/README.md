# @opensesame/vault-core

The vault format kernel of the Client plane: what a vault file is, how it is
sealed and opened, and the item model inside it. It holds the header and KDF,
the AES-GCM seals, the unlock records, items and paths, TOTP, the
offline-backup envelope, the vault-file reader, the secret-drop format and the
golden vectors. It has no host, no storage and no platform, so the PWA, the
CLI and a bare V8 isolate on Android all read vaults through the same code.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core), [`packages/cli`](../cli) (`vault verify` / `vault ls`), [`apps/pages`](../../apps/pages).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) and [`@opensesame/vault-item-types`](../vault-item-types) — no other workspace package. Its one third-party dependency is `@noble/hashes`, used by `derive.ts` for HKDF-SHA256.
- Vault cryptography is WebCrypto only: master password → PBKDF2-SHA256 → master key, which wraps a random 256-bit vault key with AES-GCM; PIN and passkey PRF are further wraps of the same key.
- `openVaultFile` reads a sealed export or offline backup down to what may be shown — tomb, binding, revision, and each item's name, kind and path. No field value leaves the module.
- `pnpm quality:app-core` gates it with no browser global outside the runtime contract, no reach into an app, and no import cycle ([ADR 0133](../../docs/adr/0133-shared-app-core.md)).

## Surface

Import from the root: `import { openVaultFile } from "@opensesame/vault-core"`.

| Module | What it holds |
|---|---|
| `crypto.ts` | `createVault`, `unlockVaultKey`, `rewrapVaultKey`, `wrapVaultKeyWithPassword`, `sealJson` / `openJson`, `PBKDF2_ITERATIONS`, `WrongPasswordError`, `VaultCorruptError` |
| `seal-open.ts` | `openJsonForRebind` — accepts a legacy unbound seal once so the caller can rewrite it bound; `normalizeVaultBody` brings an opened body up to the current item model |
| `unlock-records.ts`, `protection-types.ts`, `protection-limits.ts` | Unlock and root-protection record types and their size limits |
| `account.ts`, `account-lines.ts`, `pepper-seal.ts` | The account item and its login methods ([ADR 0172](../../docs/adr/0172-accounts-and-login-methods.md)): `AccountItem`, `LoginMethod`, `normalizeLegacyItems` (a legacy `login` becomes an account), `credentialLine`, and the legacy pepper seal (`openWithPepper`; see the end of this file) |
| `credential.ts`, `credential-bind.ts`, `credential-split.ts`, `credential-read.ts` | Credentials as items bound to an account by reference ([ADR 0179](../../docs/adr/0179-credentials-are-entries-bound-to-accounts.md)): `createCredential`, `bindCredential`, `unbindCredential`, `splitAccount`, `resolveAccounts`, `credentialSubtitle` |
| `produce.ts`, `derive.ts`, `character-rules.ts`, `pepper-position.ts` | The one password facade `producePassword` ([ADR 0174](../../docs/adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)); derived passwords from a root secret and a counter, HKDF-SHA256 with rejection sampling ([ADR 0173](../../docs/adr/0173-algorithmic-passwords-by-default.md)): `mintRootSecret`, `deriveCharacters`; the shared character builder; where a pepper goes, `parsePepperPosition` / `splitAtPepper` |
| `model.ts`, `item-factory.ts`, `login-uri.ts`, `paths.ts`, `tree-rows.ts` | `VaultBody`, `VaultItem` kinds, `createItem`; item paths and `tombPath`; `buildRows`, the headless listing |
| `merge.ts`, `item-merge.ts`, `stamps.ts`, `device-key.ts`, `sync-model.ts` | Merging two opened snapshots deterministically, field by field, with tombstones ([ADR 0144](../../docs/adr/0144-tailnet-vault-sync.md)): `mergeVaultBodies`, `mergeItem`, `restampEdits`; the device identity key a body carries |
| `item-types.ts` | This device's item-type registry: `installItemType`, `uninstallItemType`, `definitionFor`, `typedSubtitle` |
| `totp.ts` | `parseTotp`, `totpCode`, `hotpCode`, `totpSetupUri` |
| `offline-backup-format.ts` | `buildOfflineBackupEnvelope`, `parseOfflineBackupEnvelope`, `assertCiphertextOnlyBackupJson` |
| `vault-file.ts` | `openVaultFile`, `readVaultFile`, `openVaultBody`, `summarizeVaultBody` |
| `drop-format.ts` | `sealDrop`, `openDrop` — 1 MiB chunks, v1 capped at 1 MiB ciphertext |
| `file-parts.ts` | `sealFile`, `openFile`, `readFileManifest` — 1 MiB encrypted parts and a text manifest ([ADR 0054](../../docs/adr/0054-file-attachment-storage.md)) |
| `bytes.ts` | The one base64 / base64url implementation |

## Develop

```bash
pnpm --filter @opensesame/vault-core test
pnpm --filter @opensesame/vault-core typecheck
pnpm quality:app-core
```

[`spec/conformance/vault-vectors.json`](../../spec/conformance/vault-vectors.json)
holds the golden vectors (synthetic data, ADR 0139). They are read by this
package's tests, by `app-core` (including the bare-isolate test), by the CLI's
tests and by the Rust reader in `crates/human-vault` (`pages_vault`). Never regenerate them to make a test pass: a
vector that stops opening is a format break.

## Related

- [ADR 0133](../../docs/adr/0133-shared-app-core.md) — the shared app core and the vault format kernel
- [Vault format v1](../../docs/architecture/vault-format-v1.md) — header, key wraps and portable envelopes
- [ADR 0062](../../docs/adr/0062-secret-drop.md) and [secret drop design](../../docs/design/secret-drop.md)
- [ADR 0087](../../docs/adr/0087-vault-item-type-plugins.md) — item types

A pepper seal is legacy and read-only. Nothing writes one now
([ADR 0174](../../docs/adr/0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)):
a pepper is not asked for and not stored. `openWithPepper` still opens the two
versions an older build wrote, so a vault that holds one can turn it into an
ordinary stored password: version 2 gives each password a fresh random data key
wrapped by the pepper-derived PBKDF2 key and authenticates the account/method
binding and KDF metadata, and version 1 direct seals remain readable for
unambiguous legacy bindings. `sealWithPepper` stays for the fixtures that build
such a vault.
