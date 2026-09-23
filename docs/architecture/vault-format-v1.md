# Vault format v1 — the Pages tomb header, wraps and portable envelopes

Status: Descriptive. This records what the code does today; it is not a
proposal.
Date: 2026-09-22
Source of truth: `packages/app-core/src/lib/vault/crypto.ts`,
`lib/vault/unlock-methods.ts`, `lib/vault/seal-rebind.ts`,
`lib/vault/offline-backup.ts`, `lib/vault/store.ts` (`exportSealed`,
`importSealed`), `lib/vault-backup-sync.ts`, `lib/vfs.ts`.
Pinned by: `packages/app-core/src/lib/vault/fixtures/vault-vectors.json`
([ADR 0133](../adr/0133-shared-app-core.md) §7).

This is the contract every reader of a Pages vault must meet: the PWA, the
shared app core, the TS CLI and, later, Android. If this document and the
vectors disagree, the vectors win, and this document has a bug.

## 1. Encodings

- **Base64.** Standard alphabet with `=` padding (`btoa`/`atob`), not URL
  safe. Fields ending in `B64` hold it.
- **Text.** UTF-8 (`TextEncoder`). JSON is `JSON.stringify` with no
  canonicalisation: readers must parse, never compare bytes.
- **`SealedBlob`** is `{ "ivB64": string, "ctB64": string }`:
  - AES-256-GCM;
  - a 12-byte random IV;
  - a 128-bit tag appended to the ciphertext, as WebCrypto does.

## 2. Keys

| Name | What it is |
|---|---|
| VK, vault key | 32 random bytes, used as an AES-256-GCM key. One per vault. Seals the body and the sealed header fields. |
| MK, master key | PBKDF2-HMAC-SHA-256 over the password, giving an AES-256-GCM key. Wraps VK. |
| PIN KEK | Same derivation as MK over the PIN, with its own salt and iteration count. |
| PRF KEK | HKDF-SHA-256 over a WebAuthn PRF output. |

**Password and PIN normalisation.** The string is normalised with
`String.prototype.normalize("NFKC")` before UTF-8 encoding. A host without
full Unicode normalisation derives a different key for any password that
NFKC changes. It must refuse to run, never "try anyway".

## 3. Header (`VaultHeader`, plaintext)

The header is stored unsealed. It reveals parameters, never content.

```json
{
  "v": 1,
  "kdf": { "alg": "PBKDF2-SHA256", "saltB64": "<16 bytes>", "iterations": 600000 },
  "wrap": { "ivB64": "…", "ctB64": "…" },
  "unlocks": { "…": "see §5" },
  "createdAt": "<ISO 8601>",
  "hint": "<optional, self-authored>",
  "bodyRev": 12,
  "protection": { "…": "RootProtectionManifest, ADR 0129" }
}
```

**Required fields and their rules**
- `v` must be `1`.
- At least one of `wrap` or `unlocks.passkey(s)` or `unlocks.pin` must
  exist.
- **KDF validation (`assertKdfParams`):**
  - `alg` is exactly `"PBKDF2-SHA256"`;
  - `iterations` is an integer from 600,000 to 10,000,000 inclusive;
  - the salt decodes to exactly 16 bytes.

  Anything else is `VaultCorruptError`, raised before any derivation, so an
  edited header cannot weaken the KDF.

**`bodyRev`** is the highest body revision written. It is recorded after
the body lands. A body whose sealed `rev` is lower than `bodyRev` is an
older copy, a rollback.

**`protection`** is the ADR 0129 manifest. It has its own cross-language
vectors in `lib/vault/protection/fixtures/shared-vectors.json`.

## 4. Password wrap

- `wrap = AES-GCM(MK, VK)`, with **no** additional data.
- `MK = PBKDF2-SHA256(NFKC(password), kdf.salt, kdf.iterations)`, 256-bit.
- A tag failure on `wrap` is `WrongPasswordError`. That is the only way a
  wrong password is detected.

## 5. Alternate unlocks (`header.unlocks`)

These wrap the same VK. Listing several methods is any-of, not MFA
(ADR 0129 §3).

| Field | Contents |
|---|---|
| `pin` | `{ kdf, wrap }`, with the §3 KDF rules. Written with 1,200,000 iterations. The PIN is 8–12 characters, checked before derivation. `wrap = AES-GCM(PIN KEK, VK)`, no additional data. |
| `passkeys[]` / legacy `passkey` | `{ credentialIdB64, userIdB64, prfSaltB64, wrap }`. `wrap = AES-GCM(PRF KEK, VK)`, no additional data. `PRF KEK = HKDF-SHA-256(ikm = PRF output, salt = prfSalt, info = "opensesame/vault/webauthn-prf/v1")`, which matches `crates/human-vault` `kek_from_webauthn_prf`. On read, a lone `passkey` becomes a one-element list, and is prepended when its credential id is not already in `passkeys`. |
| `totp` | `{ secretWrap: AES-GCM(VK, seed), digits: 6, period: 30, selfItemId? }`. A second step, not an unlock. |
| `email`, `sms` | `{ toWrap: AES-GCM(VK, address), since }`. |
| `recovery` | `{ codesWrap: AES-GCM(VK, {codes, used}), total, since }`. |

PIN and passkey wraps belong to the device that enrolled them. Only the
password wrap is portable, which is why `importSealed` refuses an export
that has no `wrap`/`kdf`.

## 6. Body

The plaintext is `VaultBody` JSON:

```json
{ "v": 1, "items": [], "folders": [], "itemTypes": {}, "rev": 12 }
```

**Sealing**
- The body is sealed under VK with **additional data**. The additional data
  is the UTF-8 bytes of `"vault-seal" U+0000 <tomb> U+0000 "body"`
  (`vaultSealBinding(tomb, "body")`).
- `<tomb>` is `personal` for the personal vault, the project id for a
  project vault, and the guest tomb name for a guest.

**Legacy unbound seals.** Bodies written before the binding existed carry
no additional data. `openJsonForRebind` tries the bound seal first. Only
when that fails with a tag mismatch does it try unbound, and it reports
`rebound: true`, so the store can rewrite the seal with the binding.

A reader should surface whether a body opened bound or unbound. An unbound
body proves only that it was sealed under this VK, not which tomb it belongs
to.

A tag failure on both attempts is `VaultCorruptError("authentication tag
mismatch")`.

## 7. Portable envelopes

### 7.1 Sealed export — `opensesame-vault-export` v1

Written by `VaultStore.exportSealed`. Read by `VaultStore.importSealed`.

```json
{ "format": "opensesame-vault-export", "v": 1, "exportedAt": "…",
  "tomb": "personal", "header": { }, "body": { "ivB64": "…", "ctB64": "…" } }
```

- **Tomb for the binding:** `tomb` when it is a non-empty string; otherwise
  the importing vault's own tomb.
- **Rejected:**
  - `format` is not `opensesame-vault-export`;
  - `header` or `body` is missing;
  - the header has no password wrap.

### 7.2 Offline backup — `opensesame-offline-backup` v1

Written by `buildOfflineBackup` / `serializeOfflineBackup`. Pushed by
`vault-backup-sync.ts` to a git remote.

```json
{ "format": "opensesame-offline-backup", "v": 1, "projectId": null,
  "exportedAt": "…", "vault": { "header": { }, "body": { } },
  "syncBlobs": [ { "id": "…", "epoch": 1, "ciphertextB64": "…" } ],
  "deploymentSealUsed": false }
```

- **Tomb for the binding:** `projectId ?? "personal"`. The writer sets
  `projectId = tomb === "personal" ? null : tomb`
  (`vault-backup-sync.ts`).
- **Rejected:**
  - the file is larger than 64 MiB;
  - `format` or `v` differs;
  - `deploymentSealUsed !== false`;
  - the vault part is missing or malformed;
  - there are more than 4,096 sync blobs;
  - the text contains any of the plaintext markers in
    `FORBIDDEN_SUBSTRINGS`: `"plaintext"`, `"password":`, `"secret":`,
    `"token":`, `OPENSESAME_CONNECTION_KEY`, `deployment_seal`.
- Sync blobs are opaque ciphertext and are not opened by a vault reader.

## 8. Storage layout (device only, not portable)

Per ADR 0063, each tomb lives under the flat key prefix `tomb/<name>/`:
- `header`: plaintext `VaultHeader`
- `body`: `SealedBlob` as in §6
- `index`: sealed with binding path `index`
- `config/*`: sealed
- `migrated.v1` and `seal-bound.v1`: plaintext markers

`tombs.v1` lists the tomb names. Lockout counters sit outside the tomb, in
plaintext. The portable envelopes carry only `header` and `body`.

## 9. What a conforming reader must do

1. Parse the envelope (§7) and refuse anything §7 rejects.
2. Validate the header KDF (§3) **before** deriving.
3. Derive MK with NFKC normalisation (§2) and unwrap VK. A tag failure here
   means the password is wrong.
4. Open the body bound to the envelope's tomb, falling back to unbound
   (§6). Report which one opened.
5. Compare the sealed `body.rev` with `header.bodyRev` and report a
   rollback. Never "repair" it.
6. Never write VK, MK or any plaintext anywhere.
