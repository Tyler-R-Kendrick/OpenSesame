# @opensesame/vault-core

The vault format kernel of the Client plane: what a vault file is, how it is
sealed and opened, and the item model inside it. It holds the header and KDF,
the AES-GCM seals, the unlock records, items and paths, TOTP, the
offline-backup envelope, the vault-file reader, the secret-drop format and the
golden vectors. It has no host, no storage and no platform, so the PWA, the
CLI and a bare V8 isolate on Android all read vaults through the same code.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core), [`packages/cli`](../cli) (`vault verify` / `vault ls`), [`apps/pages`](../../apps/pages), [`apps/ceremonies`](../../apps/ceremonies) (opens secret drops, `src/lib/drop.ts`).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) and [`@opensesame/vault-item-types`](../vault-item-types) — nothing else.
- Cryptography is WebCrypto only: master password → PBKDF2-SHA256 → master key, which wraps a random 256-bit vault key with AES-GCM; PIN and passkey PRF are further wraps of the same key.
- `openVaultFile` reads a sealed export or offline backup down to what may be shown — tomb, binding, revision, and each item's name, kind and path. No field value leaves the module.
- `pnpm quality:app-core` gates it with no browser global outside the runtime contract, no reach into an app, and no import cycle ([ADR 0133](../../docs/adr/0133-shared-app-core.md)).

## Surface

Import from the root: `import { openVaultFile } from "@opensesame/vault-core"`.

| Module | What it holds |
|---|---|
| `crypto.ts` | `createVault`, `unlockVaultKey`, `rewrapVaultKey`, `wrapVaultKeyWithPassword`, `sealJson` / `openJson`, `PBKDF2_ITERATIONS`, `WrongPasswordError`, `VaultCorruptError` |
| `seal-open.ts` | `openJsonForRebind` — accepts a legacy unbound seal once so the caller can rewrite it bound |
| `unlock-records.ts`, `protection-types.ts`, `protection-limits.ts` | Unlock and root-protection record types and their size limits |
| `model.ts`, `login-uri.ts`, `paths.ts`, `tree-rows.ts` | `VaultBody`, `VaultItem` kinds, `createItem`, `mergeVaultBodies`; item paths and `tombPath`; `buildRows`, the headless listing |
| `item-types.ts` | This device's item-type registry: `installItemType`, `uninstallItemType`, `definitionFor`, `typedSubtitle` |
| `totp.ts` | `parseTotp`, `totpCode`, `hotpCode`, `totpSetupUri` |
| `offline-backup-format.ts` | `buildOfflineBackupEnvelope`, `parseOfflineBackupEnvelope`, `assertCiphertextOnlyBackupJson` |
| `vault-file.ts` | `openVaultFile`, `readVaultFile`, `openVaultBody`, `summarizeVaultBody` |
| `drop-format.ts` | `sealDrop`, `openDrop` — 1 MiB chunks, v1 capped at 1 MiB ciphertext |
| `bytes.ts` | The one base64 / base64url implementation |

## Develop

```bash
pnpm --filter @opensesame/vault-core test
pnpm --filter @opensesame/vault-core typecheck
pnpm quality:app-core
```

`src/fixtures/vault-vectors.json` holds the golden vectors (synthetic data).
They are read by this package's tests, by `app-core` (including the bare-isolate
test) and by the CLI's tests. Never regenerate them to make a test pass: a
vector that stops opening is a format break.

## Related

- [ADR 0133](../../docs/adr/0133-shared-app-core.md) — the shared app core and the vault format kernel
- [Vault format v1](../../docs/architecture/vault-format-v1.md) — header, key wraps and portable envelopes
- [ADR 0062](../../docs/adr/0062-secret-drop.md) and [secret drop design](../../docs/design/secret-drop.md)
- [ADR 0087](../../docs/adr/0087-vault-item-type-plugins.md) — item types
