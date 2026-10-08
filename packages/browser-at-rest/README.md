# @opensesame/browser-at-rest

At-rest envelopes for browser storage outside the Pages app (ADR 0149).
Every write generates a fresh 256-bit data key. An independently generated,
non-extractable AES-GCM wrapping key for its canonical store/name context
wraps that data key. IndexedDB keeps these context keys across reloads in
`opensesame-client-at-rest`; the caller's trusted context selects the key.
Customer-origin record names therefore have independent wrapping keys.

The `osc2.` base64 frame contains wrapping IV (12 bytes), wrapped data key
(48), payload IV (12), and ciphertext/tag. Both layers authenticate canonical
context; payload authentication also binds the complete wrapping header.
Unknown versions and malformed frames return `null`.

Legacy `osc1.` values remain readable under the original IndexedDB device
key and their original store/name context. New writes always use envelopes.
The browser SDK additionally binds configured issuer and client identity;
its old unscoped session and PKCE records cannot prove that ownership and
are discarded, requiring sign-in again.

## Where it fits

- **Used by:** [`packages/sdk-browser`](../sdk-browser) (the PKCE transaction,
  return path and session a relying party keeps), [`packages/static-auth`](../static-auth)
  (the hosted client's transaction between `begin` and `complete`),
  [`apps/browser-extension`](../../apps/browser-extension) (`hostApiBase`, and
  the seal it hands `client-core`'s sync store) and
  [`examples/siop-rp`](../../examples/siop-rp) (its sealed sign-in state).
  `packages/control-plane` declares it for a test only.
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
| `useClientAtRestKeys(keys)` | Replace the key provider; it receives an optional canonical context, or no context for legacy device-key reads |
| `isSealedForRest(value)`, `CLIENT_AT_REST_PREFIX` (`osc2.`), `CLIENT_AT_REST_DATABASE` | Whether a value carries a seal prefix (`osc`), the current frame prefix and the IndexedDB database that holds the keys |

## What it does not protect

IndexedDB retains usable non-extractable keys; it does not provide independent
customer hardware or OS keychain custody. Injected providers own their key
segmentation policy. Script running in the same origin can use the keys;
it protects what rests on disk, not the page. See ADR 0149.
