# Secret drop — share ceremony + burner items

Design contract. Decision record: [ADR 0062](../adr/0062-secret-drop.md).
Sibling contracts: [access-screen.md](access-screen.md) (hard rules apply:
no prose, a ceremony per fork).

A drop shares a secret (or an encrypted file) exactly once: client-side
E2EE, key in the URL fragment, single-use presentation, time-boxed,
disposed on consumption.

## Pieces

### 1. `lib/vault/drop.ts` (new)

- `sealDrop(payload: DropPayload) → {manifest, fragmentKey}` — fresh
  AES-GCM-256 drop key per drop; payload `{text}` or file chunks (1 MiB
  chunks, per-chunk + whole digests, ADR 0054 layout). `manifest` =
  `{kind: "secret-drop", name, contentType, ciphertext, nonce, chunks?}`
  (≤ 1 MiB total ciphertext, enforced with a clear error).
- `openDrop(manifest, fragmentKey) → DropPayload` — decrypt + digest verify.
- `createDropSession(manifest, ttlMs) → {claimId, bearerToken, userCode,
  verifyUrl}` — `POST /v1/claims` (verify the create shape in
  `apps/control-plane/src/routes/claims.ts:165-269` FIRST; if manifest-only
  sessions are refused, STOP and report — the fallback route is an ADR 0062
  decision, don't improvise it).
- `pollDrop(claimId)` — `GET /v1/claims/:id/poll` → state mapping
  (`pending|consumed|expired`).
- `dropLink(verifyUrl, bearerToken, fragmentKey)` — ceremonies URL with
  `#key=` fragment (fragment never leaves the browser).
- Seam-wrapped (`dropSeams`), BoundaryValue guards, typed `DropError`.

### 2. The `drop` vault kind

- `lib/vault/model.ts`: add kind `drop` — label "Drop", plural "Drops".
  A drop item is a **record**: `name`, `state: pending|consumed|expired`,
  `claimId`, `expiresAt`, `createdAt`, optional `keptCopy` (the payload,
  only when the user checked *Keep a copy*). No payload otherwise.
- Icon (`IconUpload` or a new flame/hourglass glyph), filter row, crumbs
  label, KIND_ORDER after secrets.
- Disposal: when poll says `consumed` or the TTL lapses, the item is
  purged (`purgeItem`) on next vault read — drops clean themselves up.

### 3. Share ceremony (on secrets)

- **Share** button on secret rows/detail → ceremony:
  1. TTL picker (10m / 1h / 1d).
  2. *Keep a copy* checkbox (default off for drops created from +new;
     default on when sharing an existing vault secret — the vault item
     itself is untouched either way; this governs only the drop record).
  3. Seal + create → **drop card**: link (copy), user code (copy), QR,
     expiry. One line: whoever opens the link and enters the code sees it
     once.
- The ceremony never shows the plaintext again after sealing.

### 4. +new → Drop

New item flow: name, text **or** file picker, TTL, keep-a-copy (default
off) → seal → create → drop card. The payload never enters the vault body
unless kept.

### 5. Acceptance page (`apps/ceremonies`)

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
- Ceremonies app changes are additive (new branch), no restructure.

## Test plan

- `drop.test.ts`: seal/open round-trip (text + chunked file), tamper →
  digest failure, manifest cap enforced, fragment key absent from every
  seam call body.
- Model tests: `drop` kind create, state transitions, purge-on-terminal.
- Section tests: share ceremony on a secret (TTL → seal → drop card with
  link + code; keep-copy semantics), +new drop flow (file never written to
  vault body when keep is off), poll-consumed purges the item.
- Ceremonies: drop branch renders reveal after present; second visit shows
  the consumed line.

Gates: `pnpm --filter @opensesame/pages test` (+ ceremonies app tests),
`tsc --noEmit` both apps, per-file oxlint anti-slop, biome.
