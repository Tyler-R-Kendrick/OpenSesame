# ADR 0148 — Nothing the client stores rests in the clear

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0063](0063-encrypted-vfs-tombs.md) (the encrypted VFS and
  its plaintext boundary), [ADR 0133](0133-shared-app-core.md) (one core,
  platform ports), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (Pages needs no backend)
- Amends: ADR 0063's plaintext boundary — it is now sealed under the device
  key; only the vault key's own seal remains the vault's protection

## Context

The vault body was always ciphertext under the vault key. Almost everything
around it was not. On a build of `main` from 2026-09-28, a Google sign-in
followed by a read of the origin's storage found **17 of 17** app-owned
values in the clear, among them:

- **Web Storage**: the federation session (the upstream ID token and the
  person's name and pairwise subject), the PKCE verifier in flight, the claim
  bearer between ceremony steps, join invites, wallet leases and spent
  assertions, the guest principal, settings, ambient-auth state.
- **Origin-private files**: ADR 0063's documented plaintext boundary — vault
  header parameters, lockout counters, the tomb registry — plus the
  capability selection and consent receipts.
- **IndexedDB**: provisional history accounts, each with its `anonToken`
  credential handle.
- **MSAL**: the Entra token cache and account records, written straight to
  `sessionStorage`.
- **Outside Pages**: the browser extension's `hostApiBase` in
  `chrome.storage.local`, and `client-core`'s sync store (device id and epoch
  beside the ciphertext). The CLI's `local-storage.json` held what a
  browser's Web Storage holds.

Anything that reads a browser profile's storage files — an infostealer
scraping `Local Storage/leveldb` for tokens, a forensic image, a backup —
read all of it.

## Decision

### 1. One device key per host, held by the host

A new optional port, `Ports.atRestKeys` (`AtRestKeyPort`), yields 32 bytes:

- **Browser** (`lib/at-rest/idb-key-store.ts`): one IndexedDB record,
  `opensesame-at-rest/keys/device`, holding a **non-extractable** AES-GCM key
  and the data key sealed under it. Script can use the wrapping key and never
  read it; the data key exists in the clear only in the document's memory.
  Two tabs minting at once race on `add`, and the loser reads the winner.
- **CLI** (`node/at-rest-key-file.ts`): `at-rest.key` beside, never inside,
  `local-storage.json`: 0600, written whole and linked into place.
- **Tests**: a per-process key the host has at hand (`loadSync`).
- **No port** (the Android sandbox today): a key that dies with the process.

### 2. One seal

`osr1.` + base64url(24-byte nonce ‖ XChaCha20-Poly1305 ciphertext and tag),
with the store and the name bound as associated data
(`lib/at-rest/cipher.ts`). A value copied under another key, area or file
name does not open. Synchronous, because Web Storage is: `@noble/ciphers`,
already a dependency, not SubtleCrypto.

### 3. Sealed at the one door each store has

- **Web Storage**: the ports' `local` and `session` stores
  (`ports.ts` → `lib/at-rest/web-storage.ts`) seal on write and open on read.
  Key names stay readable: "Reset this browser" removes by name
  (`storage-ownership.ts`), and the names are the app's, not the person's.
- **Origin-private files**: `kv.ts` seals every file bound to its file name;
  travel (`travel/storage.ts`) opens on read and seals on write, so a bundle
  carries the vault, not this browser's seal on it — a vault can come home
  to a browser that was reset while it travelled.
- **IndexedDB**: history rows are `{ id, accountId?, sealed }`; the random
  row id and the random account id the index needs are all that stays
  readable.
- **MSAL**: `cacheLocation: "memoryStorage"`. A cached account was only ever
  a routing hint; every sign-in verifies a fresh ID token.
- **Extension and `client-core`**: `sealForRest` / `openFromRest`
  (`packages/client-core/src/at-rest.ts`), `osc1.` + AES-GCM under a
  non-extractable key in the extension origin's own IndexedDB.

### 4. The key's three states, and what a store does in each

- **pending** — a browser key is still loading. A write waits in memory and
  is sealed to disk when the key lands; a read of a sealed value throws
  rather than report "absent", so no read-modify-write can clobber it. The
  shell starts the load when it installs the host and boot awaits it before
  reading anything; the address-bar captures that run first only write.
- **durable** — writes are sealed and persist.
- **ephemeral** — no key could be kept (no IndexedDB, or the load failed).
  Nothing reaches disk at all and nothing on disk is overwritten: the stores
  keep this document's writes in memory, and `kvDurability()` reports
  `memory`, which the vault already states on screen. A browser that will
  not keep a key keeps nothing past the tab rather than keep it in the clear.

### 5. Migration

A value an older build left in the clear is read as it is and sealed where it
lies. Boot sweeps the rest before hydrating: every app-owned Web Storage key
(never another project site's key on the shared origin, never MSAL's), every
`opensesame-pages-*` file (under a Web Lock, checking a five-byte prefix, so a
sealed file is never rewritten), and every history row on first use. The
extension seals `hostApiBase` on its next read.

## What this protects, and what it does not

It protects everything the app stores against **reading the storage at
rest**: a tool, script or person reading the profile's Web Storage, OPFS or
IndexedDB contents finds only seals. That includes token scrapers that
search LevelDB files. To open them they would also have to recover the
non-extractable key from the browser's own IndexedDB serialization, which
means attacking the browser, not reading a file.

It does **not** protect against code running **in this origin**. XSS, a
malicious extension content script, or another project site under the same
`<account>.github.io` origin can ask the browser to use the key, exactly as
the app does. Against those, the vault key (passkey, PIN or password) stays
the only protection for vault contents, as before. Nor does it hide
**metadata**: key names, file names (tomb ids, never names, ADR 0089), sizes
and timestamps.

Three things remain outside the seal, by decision:

- MSAL's **request in flight** (state, PKCE verifier) in `sessionStorage`
  during an Entra redirect. MSAL writes it itself, reads it back raw, and
  removes it when the redirect completes.
- The **service worker's Cache API**: the public app shell, byte for byte
  what every visitor downloads. It holds nothing of the person's.
- **`@opensesame/sdk-browser` and `@opensesame/static-auth`** on a relying
  party's own origin. Their storage contract is synchronous and public;
  sealing it is a separate SDK change with its own ADR.

The app sets no cookies. The Identity API's session cookie is `HttpOnly` and
opaque, and is set by the server.

## Verification

- `lib/at-rest/at-rest.test.ts`, `at-rest-stores.test.ts`: the seal, the
  three key states, each store raw, the two-tab key race, legacy migration,
  the CLI key file.
- `pnpm --filter @opensesame/pages verify:static` reads the origin's storage
  raw after the guest road and again after Google sign-in
  (`scripts/lib/at-rest-contract.mjs`). Every app-owned value, file and row
  must be `osr1.`. The guest's name, the pairwise subject and the person's
  name must appear nowhere. The key must be non-extractable.
- Upgrade, checked by hand for this change: a Google sign-in on the base
  build left 17 of 17 values in the clear. Reloading the same profile on this
  build sealed all 17 and landed on the same screen.

## Consequences

- Losing the device key (clearing IndexedDB alone) makes everything sealed
  under it unreadable. It is deleted only with everything else, by "Reset
  this browser" (`APP_DATABASES`) or by clearing site data. Travel bundles
  carry opened content and are unaffected.
- A new store must go through the ports, `kv.ts` or `history-backup-idb.ts`
  pattern; writing a browser global directly bypasses the seal, and the
  static-origin check will find the plaintext.
