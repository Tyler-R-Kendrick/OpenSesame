# Vault format v1 — the Pages tomb header, wraps and portable envelopes

Status: Descriptive. This records what the code does today; it is not a
proposal.
Date: 2026-09-22
Source of truth: the format kernel `@opensesame/vault-core`
(`packages/vault-core/src/crypto.ts`, `unlock-records.ts`, `seal-open.ts`,
`offline-backup-format.ts`, `vault-file.ts`), and in the app core
`packages/app-core/src/lib/vault/unlock-methods.ts`, `seal-rebind.ts`,
`store.ts` (`exportSealed`, `importSealed`), `lib/vault-backup-sync.ts`,
`lib/vfs.ts`. The native reader is `crates/human-vault` `src/pages_vault/`
(`opensesame vault verify|ls`).
Pinned by: `spec/conformance/vault-vectors.json`
([ADR 0133](../adr/0133-shared-app-core.md) §7,
[ADR 0139](../adr/0139-one-definition-every-target.md)), opened by
`packages/vault-core` (`vault-file.test.ts`), `packages/app-core`
(`vault-vectors.test.ts`, the bare-isolate proof) and the Rust reader
(`crates/human-vault/tests/pages_vault_vectors.rs`).

This is the contract every reader of a Pages vault must meet: the PWA, the
shared app core, the TS CLI, the native binary and, later, Android. If this document and the
vectors disagree, the vectors win, and this document has a bug.

## 1. Encodings

- **Base64.** Standard alphabet, written with `=` padding as `btoa` does, not
  URL safe. A reader accepts what `atob` accepts (padding optional, ASCII
  whitespace ignored). Fields ending in `B64` hold it.
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
| `pin` | `{ kdf, wrap }`, with the §3 KDF rules. Written with 1,200,000 iterations. The PIN is 8–64 characters, checked before derivation. Duress codes stay 8–12 digits (ADR 0155). `wrap = AES-GCM(PIN KEK, VK)`, no additional data. |
| `passkeys[]` / legacy `passkey` | `{ credentialIdB64, userIdB64, prfSaltB64, wrap }`. `wrap = AES-GCM(PRF KEK, VK)`, no additional data. `PRF KEK = HKDF-SHA-256(ikm = PRF output, salt = prfSalt, info = "opensesame/vault/webauthn-prf/v1")`, which matches `crates/human-vault` `kek_from_webauthn_prf`. On read, a lone `passkey` becomes a one-element list, and is prepended when its credential id is not already in `passkeys`. |
| `totp` | `{ secretWrap: AES-GCM(VK, seed), digits: 6, period: 30, selfItemId? }`. A second step, not an unlock. |
| `email`, `sms` | `{ toWrap: AES-GCM(VK, address), since }`. |
| `recovery` | `{ codesWrap: AES-GCM(VK, {codes, used}), total, since }`. |

A tailnet snapshot omits the PIN wrap (`portableHeader`). The file readers
(`openVaultFile`, the native `opensesame vault`) open a sealed export only by
its password wrap, so they need `wrap` and `kdf`; the store's `importSealed`
also opens an export whose only wrap is a PIN, given the PIN. An offline
backup keeps the unlock the vault has: the password when `wrap` and `kdf` are
set, otherwise the passkey, otherwise the PIN. That same unlock opens the
file.

## 6. Body

The plaintext is `VaultBody` JSON:

```json
{ "v": 1, "items": [], "folders": [], "itemTypes": {}, "rev": 12 }
```

Optional members (`itemTypesAt`, `tombstones`, `masterWrap` — the current
master-password wrap, ADR 0144 — and `deviceIdentityKey`, below).
A reader that does not know one ignores it on read. A build from before one was
added also drops it on its first re-save of the body, because it rebuilds the
body from the members it knows; the next merge or reconcile on a build that
knows the member puts it back from another device or from the tomb. A file
written between those two moments does not carry it.

**`deviceIdentityKey`** (ADR 0160 §5a) carries the vault's device identity
key, so its principal travels with the vault: a P-256 key whose RFC 7638
thumbprint is the principal (`prn_` + thumbprint).

```json
{ "version": 1, "keyId": "<43 base64url>", "createdAt": 1790000000000,
  "publicJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "privateJwkJson": "<serialized private JWK>" }
```

It is a secret and sits only inside the sealed body. A lister names its path,
`config/device-identity-key`, and never a member of it (`opensesame vault
ls` prints `config/device-identity-key<TAB>concealed`). `null` is absent; any
other value is listed by name. A writer's record is trusted only when:
- `keyId`, `publicJwk.x` and `publicJwk.y` are each the canonical base64url of 32
  bytes: exactly 43 characters of `A-Za-z0-9_-` whose last character has its two
  padding bits zero (a respelling of the same bytes is another string for the
  same key, and is not read);
- `privateJwkJson` is at most 4096 characters;
- `keyId` is the RFC 7638 thumbprint of `publicJwk` and `privateJwkJson` is that
  public key's private half;
- `createdAt` is a whole time, in milliseconds, no more than a day past the
  reader's clock and, for a reader that knows the vault's header, no more than a
  day before the header's `createdAt`.

Anything else is no key. Two trusted keys of one vault, met in an authenticated
merge, rank by the older `createdAt`, then the smaller `keyId` in plain
code-unit order. The date a key ranks by is the date it was *published* under: a
writer clamps the date of a key it carries into the window above (never later
than now), and a restore that takes a backup's key dates it just before the key
it replaces, so that choice outranks the old key on every device that holds it.
A record whose `version` a reader does not know is kept as it is and never
replaced, but only when it is shaped as a key record is (a whole `version` above
1, a text `keyId` of at most 128 characters, an object `publicJwk`, at most 8192
characters of JSON); a high `version` on anything else is no key. A backup's key
is never ranked against a vault's: it is taken only by a person who chooses to.
The vector `backup-device-identity`, and `concealedBodies` for which body shapes
are listed, are in `spec/conformance/vault-vectors.json`. The native reader does
not validate the key; it reports only that the member is present, so none of the
rules above is one it needs to agree on.

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
  the importing vault's own tomb. A reader that opens a file on its own (the
  native `opensesame vault`) has no importing vault, so it refuses an export
  that names no tomb.
- **Rejected:**
  - `format` is not `opensesame-vault-export`;
  - `header` or `body` is missing;
  - the header has no password wrap (the native reader refuses it on
    reading; `openVaultFile` fails at the unwrap; `importSealed` also
    accepts a PIN-only header, given the PIN, or a raw vault key).

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
  - there are more than 4,096 sync blobs, a sync blob lacks a string `id`, a
    numeric `epoch` or a non-empty `ciphertextB64`, or their ciphertext
    together exceeds 64 MiB;
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
plaintext. "Plaintext" here is relative to the vault format: on the device the
browser and CLI hosts also seal every stored value under their at-rest key
([ADR 0149](../adr/0149-nothing-stored-in-the-clear.md)). The portable
envelopes carry only `header` and `body`. Of the `config/*` files, one rides
inside the body: the device identity key (`config/device-identity-key`, §6),
whose working copy is the tomb file.

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
7. List a body's `deviceIdentityKey` by its path alone (§6) and print no member
   of it.
