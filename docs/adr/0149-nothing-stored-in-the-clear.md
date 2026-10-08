# ADR 0149 — Nothing the client stores rests in the clear

- Status: Accepted
- Date: 2026-09-28
- Amended by: [ADR 0175](0175-searchable-encryption-over-indexeddb.md) (§3, for
  the stores it moves into encrypted databases)
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
  a routing hint; every sign-in verifies a fresh ID token. MSAL writes Web
  Storage only for a redirect (its request in flight, in `sessionStorage`)
  or after a redirect or popup (an SSO-capability mark in `localStorage`).
  The adapter offers neither — silent SSO only — and
  `ambient-auth/entra-storage.test.ts` pins that, so MSAL writes nothing.
- **Outside Pages**: `@opensesame/browser-at-rest` — `osc1.` + AES-GCM under
  a non-extractable key in the origin's own IndexedDB, and `sealedStorage`,
  an asynchronous sealed view of any synchronous `StorageLike`:
  - the browser extension's `hostApiBase`, and `client-core`'s sync-store
    file, whose seal the extension hands `persistSealedStore` (so
    `client-core` takes no storage dependency of its own);
  - `@opensesame/sdk-browser` on a relying party's origin: the PKCE
    transaction, the return path and the session (`session-store.ts`). The
    storage contract stays synchronous; the client seals and opens around
    it. `getReturnTo()` reads what `handleRedirectCallback` loaded, and
    `resolveReturnTo()` waits for it;
  - `@opensesame/static-auth`'s hosted client: the transaction between
    `begin` and `complete`, released as hosted SDK 1.0.3 (1.0.2 and the
    loopback compatibility bytes stay frozen).
  With no key these keep values in memory, and nothing is written in the
  clear. A transaction that must outlive the redirect cannot live in memory,
  so an origin that can keep no key refuses to sign in up front
  (`storage_unavailable`) rather than fail on the callback page. The
  transaction is taken — read and removed — before anything is awaited, so
  two racing callbacks cannot both spend one verifier, and writes land in
  the order they were asked for.

### 4. The key's states, and what a store does in each

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
  Boot waits at most `AT_REST_LOAD_TIMEOUT_MS` (5 s) for the key; an
  IndexedDB open that never answers leaves the document ephemeral, not blank
  (ADR 0090), and the next load tries again. A ready listener that throws
  (a flush the quota refuses) neither fails the load nor loses the value: it
  stays held in memory.
- **lost** — the key record is gone while seals remain (IndexedDB cleared
  alone, a partial reset). The browser does not mint a new key over them
  (`sealed-evidence.ts`, which counts local storage and origin files, never
  one tab's session storage): the document runs ephemeral, and `kv.ts` refuses
  to write over any file that does not open under the key it has, so a first
  run can never put a new vault where an old one still lies. A tab whose
  browser is being reset never reopens the key's database.

### 5. Migration

A value an older build left in the clear is read as it is and sealed where it
lies. Boot sweeps the rest before hydrating: every app-owned Web Storage key
(never another project site's key on the shared origin, never MSAL's), every
`opensesame-pages-*` file (under a Web Lock, checking a five-byte prefix, so a
sealed file is never rewritten), and every history row on first use — a row
the app cannot parse is sealed whole, not dropped. The file sweep runs on
every boot — a tab of an older build may have written in the clear since —
checking only each file's first five bytes, in parallel. The extension seals
`hostApiBase` on its next read.

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

The service worker's Cache API is not sealed and holds nothing to seal: it is
the public app shell, byte for byte what every visitor downloads, and holds
nothing of the person's. The app sets no cookies. The Identity API's session cookie is `HttpOnly` and
opaque, and is set by the server.

## Verification

- `lib/at-rest/at-rest.test.ts`, `at-rest-stores.test.ts`: the seal, the
  key states, each store raw, the two-tab key race, legacy migration,
  the CLI key file.
- `pnpm --filter @opensesame/pages verify:static` reads the origin's storage
  raw after the guest road and again after Google sign-in
  (`scripts/lib/at-rest-contract.mjs`). Every app-owned value, file and row
  must be `osr1.`. The guest's name, the pairwise subject and the person's
  name must appear nowhere. The key must be non-extractable.
- `packages/browser-at-rest`, `sdk-browser/src/at-rest.test.ts` and
  `static-auth`'s hosted tests read the relying party's storage raw;
  `packages/control-plane/scripts/verify-static-auth.mjs` runs hosted
  sign-in in real Chromium against SDK 1.0.3 and asserts the pending
  transaction reaches `sessionStorage` sealed and opens after the redirect.
- Upgrade, checked by hand for this change: a Google sign-in on the base
  build left 17 of 17 values in the clear. Reloading the same profile on this
  build sealed all 17 and landed on the same screen.

## Consequences

- Losing the device key (clearing IndexedDB alone) makes everything sealed
  under it unreadable until it comes back; the app never overwrites those
  seals (§4, *lost*). The key is deleted only with everything else, by "Reset
  this browser" (`APP_DATABASES`) or by clearing site data. Travel bundles
  carry opened content and are unaffected — a travelling vault is the way to
  move a vault off a device whose key is at risk.
- **Roll forward only.** A build from before this ADR reads a seal as
  corrupt data and may write defaults over it. Do not roll Pages back past
  it, and do not run an older build beside this one on the same origin. A
  tab still showing the previous deploy reloads when the new service worker
  takes over (`main.tsx`).
- A new store must go through the ports, `kv.ts` or `history-backup-idb.ts`
  pattern; writing a browser global directly bypasses the seal, and the
  static-origin check will find the plaintext.
