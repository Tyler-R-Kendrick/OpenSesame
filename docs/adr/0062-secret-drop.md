# ADR 0062 — Secret drop: E2EE one-time sharing and burner items

Status: Accepted
Date: 2026-08-29
References: ADR 0005 (never expose raw secrets), ADR 0044 (claimable
delegation), ADR 0045 (hosted ceremony tier), ADR 0054 (file-attachment
storage), ADR 0061 (ceremony per action), claim contracts
(`packages/contracts/src/claims.ts`), ceremonies app (`apps/ceremonies`)

## Context

Two gaps were called out in review:

1. **Secrets can't be shared.** The vault has no share affordance at all —
   yet the app already ships "secret drop" machinery: claim sessions
   (bearer `osc_clm_` link + out-of-band user code + TTL + single-use
   presentation, `packages/claims`), and a hosted ceremonies app whose
   claim-acceptance page works even for guest recipients
   (`apps/ceremonies/src/pages/ClaimCeremony.tsx`). What claims cannot do
   today is carry a secret payload — the manifest is plaintext server-side
   and nothing mints item-bearing claims.
2. **No burner/drop item type.** Sharing an encrypted file or a one-time
   credential shouldn't require storing it in the vault at all; the item
   should be disposed on consumption.

The design constraint that decides the shape: OpenSesame is
passthrough/zero-knowledge — the server must never see plaintext, and the
reveal must stay human-gated (ADR 0005). A server-side "share secret"
endpoint is therefore the wrong tool; the payload must be encrypted
client-side with the key traveling out-of-band.

## Decision

**Secret drop** — a share ceremony on every vault secret, and a new `drop`
item type in the vault's **+new**:

- **Share ceremony (on any secret):** pick a TTL (10m / 1h / 1d) → the
  browser generates a fresh random **drop key** (AES-GCM-256), encrypts the
  payload client-side, and creates a claim session whose manifest carries
  only `{kind: "secret-drop", name, contentType, ciphertext, nonce}` —
  ciphertext is zero-knowledge to the server. The result is a **drop link**
  (ceremonies acceptance URL) with the drop key in the **URL fragment**
  (never sent to any server — the fragment-strip pattern already exists in
  `apps/ceremonies/src/lib/deep-link.ts`), plus the claim's user code for
  the out-of-band second factor, plus a QR (`packages/qr`).
- **Burner/drop item type (`drop`):** created from **+new** with either
  text or a **file** (chunk-encrypted in the browser, 1 MiB chunks with
  per-chunk and whole-payload digests — the ADR 0054 attachment format,
  adapted to the drop transport). The payload is **never stored in the
  vault** unless the user explicitly checks *Keep a copy*; the vault item is
  a drop *record* (name, state `pending|consumed|expired`, TTL, created).
- **Disposal on consumption:** claim presentation is already single-use
  (CAS — a second present is refused). The acceptance page fetches and
  decrypts the payload during that single presentation; the drop is thereby
  consumed. The sharer's drop record polls (`GET /v1/claims/:id/poll`) and,
  on `consumed`/`expired`, the item is **purged from the vault** — the
  burner's defining behavior. First-open-burns, like snappass/PrivateBin,
  with the user code as the second factor.
- **Recipient experience:** opens the link (ceremonies app — guest path
  already exists), enters the user code, sees the revealed secret or
  downloads the decrypted file, once. No account required.

### What this reuses vs builds

Reused: claim-session lifecycle + single-present CAS + user-code fence +
poll route (all in `apps/control-plane/src/routes/claims.ts`), ceremonies
acceptance page + deep-link fragment machinery, QR package, vault
crypto/purge (`store.ts` `purgeItem`). Built: the drop ceremony in Pages,
the `drop` vault kind + record, the client-side drop crypto
(`lib/vault/drop.ts`), payload-in-manifest carriage, and the acceptance
page's drop branch in `apps/ceremonies`.

### Decision point resolved

Verification found `POST /v1/claims` *does* accept a manifest-only session
(contracts require only `type` + a free-form `targetManifest`), but the
manifest is write-only (every read path projects only its digest) and the
user-code fence gates `complete` — which requires an authenticated
principal — not `present`. The drop transport therefore takes the reserved
fallback shape, as a deliberate server change:

- `POST /v1/claims/present` accepts an optional `userCode`, verified against
  the claim's peppered digest (same 5-attempt fence as `complete`) *before*
  the single-use CAS transition — so the code gates payload release and
  account-free recipients work.
- The present response — and only the present response — includes
  `targetManifest`. Presentation is already the single-use transition, so
  the ciphertext is served exactly once, inside the one presentation
  window; `GET`/`poll`/`complete` projections are unchanged.

### Deviations, recorded honestly

- **v1 payload cap.** Payloads travel in the claim manifest (a JSON column);
  v1 caps total ciphertext at 1 MiB and the UI says so. A chunked drop-blob
  endpoint for large files is future server work.
- **Burn = first presentation, not byte erasure.** Server-side ciphertext
  follows the claim lifecycle (expiry/cleanup); the access-refusal on
  present is the disposal that matters, and the sharer's copy is purged.
- **No recipient accounts.** Anybody with link + user code consumes the
  drop; that is the point of a drop. Per-recipient encryption needs a
  browser recipient-key model that doesn't exist yet (ADR 0063 notes it).

## Consequences

- Secrets gain a share button whose every property (E2EE, one-time,
  time-boxed, human-gated, account-free recipient) comes from machinery
  already shipped; the new surface is two ceremonies and a vault kind.
- The `drop` kind gives file sharing without vault residency — encrypted
  files move through the drop transport, not the vault body.
- The claim plane gains its first payload-carrying session kind; future
  drop shapes (multi-file, larger blobs, per-recipient) extend the same
  manifest contract.
