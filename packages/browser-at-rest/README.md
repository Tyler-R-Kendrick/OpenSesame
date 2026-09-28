# @opensesame/browser-at-rest

At-rest sealing for browser storage outside the Pages app (ADR 0148). One
non-extractable AES-GCM key per origin, kept in that origin's IndexedDB
(`opensesame-client-at-rest`): script can use it and never read it. A value is
`osc1.` + base64 of a 12-byte IV and the ciphertext, with its store and name
bound as associated data, so a value copied under another name does not open.

## Where it fits

- **Used by:** [`packages/sdk-browser`](../sdk-browser) (the PKCE transaction,
  return path and session a relying party keeps), [`packages/static-auth`](../static-auth)
  (the hosted client's transaction between `begin` and `complete`), and
  [`apps/browser-extension`](../../apps/browser-extension) (`hostApiBase`, and
  the seal it hands `client-core`'s sync store).
- **Builds on:** WebCrypto and IndexedDB only; [`@opensesame/os-domain`](../os-domain)
  for boundary guards.
- The Pages app does not use it: `@opensesame/app-core` seals synchronously
  under its own device key (`src/lib/at-rest/`), because Web Storage is read
  synchronously there.

## Surface

| Export | What it does |
|---|---|
| `sealForRest(store, name, text)` | The sealed value, or `null` when the origin can keep no key |
| `openFromRest(store, name, value)` | The plaintext; a value an older release left in the clear reads as it is; a seal that does not open reads as `null` |
| `sealedStorage(storage, scope)` | An async sealed view of any synchronous `StorageLike`: values reach it sealed, legacy plaintext is sealed where it lies, and with no key values stay in memory |
| `useClientAtRestKeys(keys)` | Replace where the key comes from (tests, an embedder with its own) |

## What it does not protect

Script running in the same origin can use the key, exactly as the SDK does;
it protects what rests on disk, not the page. See ADR 0148.
