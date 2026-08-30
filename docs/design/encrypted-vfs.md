# Encrypted VFS — tombs browser-side

Design contract. Decision record:
[ADR 0063](../adr/0063-encrypted-vfs-tombs.md). Read first:
`apps/pages/src/lib/kv.ts` (current OPFS layer),
`apps/pages/src/lib/vault/store.ts` (header/body/prefs keys, sealing),
`apps/pages/src/lib/vault/crypto.ts` (`SealedBlob`, key wrap),
`apps/pages/src/lib/idp-registry.ts`, `apps/pages/src/lib/settings.ts`,
`apps/pages/src/lib/projects.ts`, `apps/pages/src/lib/vault/host-backup.ts`
(ciphertext push — stays the git persistence path, unchanged).

## What changes

### 1. `lib/vfs.ts` (new) — the encrypted filesystem

- Paths: `tomb/<name>/body`, `tomb/<name>/config/<file>`,
  `tomb/<name>/drops/<file>`. Every write seals content with the tomb's
  vault key (existing `SealedBlob`); every read unseals.
- Per-tomb directory index (`tomb/<name>/index`, sealed) listing file names
  + revisions — listing requires the key, names stay private.
- Top-level plaintext registry `tombs.v1` = tomb names only (the
  `tombs.json` analog — names are not secrets).
- API: `readFile(tomb, path)`, `writeFile(tomb, path, bytes)`,
  `listDir(tomb, prefix)`, `deleteFile(tomb, path)`, `listTombs()`.
  Seam-wrapped (`vfsSeams`); OPFS via the existing kv transport with the
  memory fallback; no IndexedDB, no localStorage.
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
- **Stays plaintext (documented boundary, ADR 0063):** boot endpoints
  (`settings.v1` Identity/Host URLs — needed pre-unlock, non-secret), vault
  header params, lockout counters, tomb names. Do not move these.
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

- Git persistence: `host-backup.ts` ciphertext push + ADR 0039 backup
  actor. Sealed VFS files ride the same push. No browser git, no git
  credentials in the browser.
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
