# Encrypted VFS — tombs browser-side

Design contract. Decision record:
[ADR 0063](../adr/0063-encrypted-vfs-tombs.md). Read first:
`packages/app-core/src/lib/kv.ts` (current OPFS layer),
`packages/app-core/src/lib/vault/store.ts` (header/body/prefs keys, sealing),
`packages/vault-core/src/crypto.ts` (`SealedBlob`, key wrap),
`packages/app-core/src/lib/idp-registry.ts`, `packages/app-core/src/lib/settings.ts`,
`packages/app-core/src/lib/projects.ts`, `packages/app-core/src/lib/vault-backup-sync.ts`
(ciphertext push to the bound git remotes — stays the git persistence path).

> Status (2026-10-08): built. The layer is `packages/app-core/src/lib/vfs.ts`
> and the legacy migration is `packages/app-core/src/lib/vault/tomb-migration.ts`;
> the sections below record the contract they were built to.

## What changes

### 1. `packages/app-core/src/lib/vfs.ts` — the encrypted filesystem

- Paths: `tomb/<name>/body`, `tomb/<name>/config/<file>`. Every write seals
  content with the tomb's vault key (existing `SealedBlob`, bound to the tomb
  and path as additional data); every read unseals.
- Per-tomb directory index (`tomb/<name>/index`, sealed) listing file names
  + revisions — listing requires the key, names stay private.
- Top-level plaintext registry `tombs.v1` = tomb names only (the
  `tombs.json` analog — names are not secrets).
- API: `readFile(tomb, path)`, `writeFile(tomb, path, bytes)`,
  `listDir(tomb, prefix)`, `deleteFile(tomb, path)`, `listTombs()`.
  Seam-wrapped (`vfsSeams`, in `vfs-seams.ts`, which a host swaps to keep
  the bytes elsewhere); OPFS via the existing kv transport with the memory
  fallback; no IndexedDB, no localStorage.
- The vault body and header move to `tomb/<name>/body` /
  `tomb/<name>/header` (header stays plaintext params by design); legacy
  keys migrate on first open (read old → write new → delete old).

### 2. Config moves into the sealed VFS

Migrate on unlock, per tomb:

| From (plaintext) | To |
|---|---|
| `vault.prefs.v1` | `tomb/<name>/config/prefs` |
| `opensesame.idp-registry.v1` (localStorage!) | `tomb/<name>/config/idp-registry` |
| projects list | `tomb/<name>/config/projects` (per-tomb view) |
| org profile (sessionStorage) | `tomb/<name>/config/org-profile` |

- Migration = read legacy → write sealed → delete legacy → flip a
  `migrated.v1` marker. Idempotent; a crash mid-migration re-runs cleanly.
- **Stays outside the vault key (documented boundary, ADR 0063):** boot
  endpoints (`settings.v1` Identity/Host URLs — needed pre-unlock,
  non-secret), vault header params, lockout counters, tomb names. Do not move
  these. Since [ADR 0149](../adr/0149-nothing-stored-in-the-clear.md) they are
  sealed under the device's at-rest key rather than written in the clear
  (`packages/app-core/src/lib/kv.ts`).
- `lib/idp-registry.ts` keeps its API but its storage seam swaps to the
  VFS; callers don't change. It now requires an unlocked tomb — the
  Identity screen is post-unlock already; the sign-in hub must not consult
  the registry pre-unlock (verify; the first-class catalog is
  server-fetched, BYO hint comes from the sheet flow).

### 3. Tomb vocabulary

- The project/vault switcher labels stay (no UI churn), but docs and store
  comments treat each project vault as a tomb; `personal` is the personal
  tomb (ADR 0038).

### 4. What does NOT change

- Git persistence: `vault-backup-sync.ts` pushes the ciphertext snapshot
  through the Connect relay, and ADR 0039's backup actor does the same on a
  Host. Sealed VFS files ride the same push. No browser git; a forge token,
  where a remote uses one, is read from a sealed vault item at push time.
- Key wrap/enrollments, crypto primitives, OPFS transport, memory
  fallback.

## Test plan

- `vfs.test.ts`: write/read round-trip, sealed-at-rest (OPFS bytes contain
  no plaintext), index privacy, tomb listing, delete, memory fallback.
- Migration tests: each legacy store migrates sealed + legacy deleted;
  idempotent re-run; crash mid-way (marker unset) re-migrates.
- `idp-registry.test.ts`: same behavior through the VFS seam; registry
  unreadable while locked.
- Store tests updated for new key layout (header/body paths).
- Boot test: pre-unlock boot path reads only endpoints + header (assert no
  VFS access before unlock).

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome.
