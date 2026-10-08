# Secret drop — share ceremony + burner items

Design contract. Decision record: [ADR 0062](../adr/0062-secret-drop.md).
Sibling contracts: [access-screen.md](access-screen.md) (hard rules apply:
no prose, a ceremony per fork).

A drop shares a secret (or an encrypted file) exactly once: client-side
E2EE, key in the URL fragment, single-use presentation, time-boxed,
disposed on consumption.

## Pieces

### 1. `packages/app-core/src/lib/vault/drop.ts`

The sealed format (`sealDrop`, the manifest, the 1 MiB cap) is
`packages/vault-core/src/drop-format.ts`; opening a drop is
`packages/app-core/src/lib/claims/drop-open.ts`, re-exported here.

- `sealDrop(payload: DropPayload) → {manifest, fragmentKey}` — fresh
  AES-GCM-256 drop key per drop; payload `{text}` or file chunks (1 MiB
  chunks, per-chunk + whole digests, ADR 0054 layout). `manifest` =
  `{kind: "secret-drop", name, contentType, ciphertext, nonce, chunks?}`
  (≤ 1 MiB total ciphertext, enforced with a clear error).
- `openDrop(manifest, fragmentKey) → DropPayload` — decrypt + digest verify.
- `createDropSession(manifest, ttlMs) → {claimId, bearerToken, userCode,
  verifyUrl, expiresAt}` — `POST /v1/claims` with
  `{type: "resource_bundle", targetManifest, ttlSeconds}`
  (`packages/control-plane/src/routes/claims.ts`).
- `pollDrop(claimId, bearerToken)` — `GET /v1/claims/:id/poll` (the token in
  `x-claim-token`) → state mapping (`pending|consumed|expired`).
- `dropLink(verifyUrl, bearerToken, fragmentKey)` — the Pages claim URL with
  `#token=…&key=…` in the fragment (the fragment never leaves the browser).
- Seam-wrapped (`dropSeams`), BoundaryValue guards, typed `DropError`.

### 2. A drop is not an item type

Sending a drop does not create a vault item and does not appear in the
new-item picker or the kind rail. `shareOnce` seals the text, opens a
claim session, and returns the link, user code and expiry. The fragment
key stays in the link that is shown. Nothing is written back onto the item.

A `drop` record from an older vault still parses. Its kind is registered
with `creatable: false`, so an existing record can be opened and the
unlock sweep can purge it, and no creation surface offers the kind.

### 3. Share, on every item that holds text

The share sits on the item, for every type that has something to send:
a secret's value, a login's password, a card's number, a certificate's
key, a passkey's private key, a note's text, a typed item's secret field,
or the notes when the item has no concealed value. An empty item and a
legacy drop record offer no share.

- Share key on the item → ceremony:
  1. TTL picker (10m / 1h / 1d).
  2. Seal and share → **drop card**: link (copy), user code (copy), QR,
     expiry.
- The item is not saved. There is no keep-a-copy checkbox and no drop
  record to open.
- The ceremony never shows the plaintext again after sealing.

### 4. Minimal installation

`sharing.drops` is always on. The minimal vault, which creates secrets
only, can still share one. Opening a link stays on `identity.ceremonies`.

### 5. Acceptance page (Pages `/claim`; a separate ceremonies app until [ADR 0140](../adr/0140-pages-hosts-every-ceremony.md))

Drop branch on the claim acceptance page: detect `kind: "secret-drop"` in
the presented manifest → user-code field → present (single-use) → decrypt
with the fragment key → reveal text (with copy) or download the file.
Consumed state renders `This drop was already opened.`

## Data and state rules

- Server sees ciphertext only; the fragment key never transits (assert in
  tests that no fetch body contains it).
- Poll drop states on vault open and on the drop detail view; purge on
  terminal states.
- Locked vault → no share button (secrets are unreachable anyway).

## Test plan

- `packages/app-core/src/lib/vault/drop.test.ts`: seal/open round-trip (text + chunked file), tamper →
  digest failure, manifest cap enforced, fragment key absent from every
  seam call body.
- Model tests: `drop` kind create, state transitions, purge-on-terminal.
- Section tests: share ceremony on a secret and on a login (TTL → seal →
  drop card with link + code; the item is not saved), poll-consumed purges
  a legacy drop record.
- Claim page: drop branch renders reveal after present; second visit shows
  the consumed line.

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome.
