# ADR 0182 — Secrets are files: one VFS contract over an emulated store, a real directory and a private store, written on Effect

- **Status:** Accepted — implemented in `@opensesame/app-core` and the client
  CLI; wiring it into Pages (the locally hosted PWA) is the next change
- **Date:** 2026-10-07
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0063 ([encrypted VFS tombs](0063-encrypted-vfs-tombs.md)),
  ADR 0133 ([shared app-core](0133-shared-app-core.md)),
  ADR 0149 ([nothing stored in the clear](0149-nothing-stored-in-the-clear.md))
- **Uses:** ADR 0139 ([one definition, every target](0139-one-definition-every-target.md)),
  ADR 0144 ([tailnet vault sync](0144-tailnet-vault-sync.md))

## Context

The vault is a virtual filesystem (ADR 0063), and everything above it already
treats it as one: tombs, paths, sealed files. Below it, though, the vault *body*
is a single sealed blob, and the only places that blob could rest were the
browser's OPFS and, for the CLI, one `vault-kv.json` holding every record. A
person who set up OpenSesame on a server, or ran the PWA from their own machine
against their own storage, still had no files: one opaque snapshot, replaced
whole on every edit, that cannot be listed, diffed, backed up per secret,
shared one at a time, mounted read-only into one container or locked down with
the file permissions the machine already has. Authentik's blueprints and
Tailscale's tailnet policy file are the shape wanted: a declarative document per
thing, on disk, that the ordinary tools understand.

There are also two modes with different failure physics. In a browser with no
real file store the VFS is an emulation and a write either lands in OPFS or
does not. A PWA served locally for privately hosted storage writes across a
network to something that is sometimes slow, sometimes gone and sometimes
answers after the caller has stopped waiting; a write there needs a time limit,
a bounded retry and an honest account of what a lost answer meant.

## Decision

1. **One contract, four operations** (`lib/secret-fs/files.ts`). `SecretFiles`
   is `read`, `write`, `remove` and `list` over opaque bytes at relative paths.
   A write replaces the file whole or not at all, creates its parents, and may
   name the revision it expects; a **revision is the SHA-256 of the bytes**, so
   every backend agrees on it without storing it. One path rule (`checkPath`)
   is safe for every backend or for none. Failures are four typed outcomes
   (`errors.ts`): not found, conflict, unavailable (the only one worth
   retrying) and rejected. A backend maps its own failures onto them, so
   nothing above it branches on which backend it has.
2. **Three backends, one suite.** The **emulation** (`memory.ts`) is what a
   browser with no real file store, and every test, uses. The **directory**
   (`filesystem.ts`) is written once over Effect's `FileSystem` service —
   `src/node/secret-files.ts` supplies Node's — and is atomic (staged beside its
   target, flushed, renamed over it), owner-only (`0600`/`0700`), confined to
   its root (a planted symlink cannot lead out of it) and cross-process safe
   for revision-checked writes (a lock file with stale takeover, under an
   in-process mutex). The **bucket** is `s3.ts`, any S3-compatible
   service (AWS S3, MinIO, R2, B2, Ceph) signed with `s3-sigv4.ts` (checked
   against Amazon's worked examples): the four operations are `GetObject`,
   `PutObject`, `DeleteObject` and `ListObjectsV2`; a write that names a
   revision reads the object, compares its SHA-256, and puts with
   `If-Match: <ETag>` (`If-None-Match: *` to create), so the bucket decides a
   race and not the network. It needs no server of ours, which is why a browser
   can use it. There is no bespoke HTTP store. `files.conformance.ts` is the one suite all of
   them pass, and `vault-on-files.conformance.ts` runs the whole vault on the
   emulation, on a disk, and on a bucket behind `resilient`.
3. **The VFS is unchanged for its callers.** `vfsSeams` (now `vfs-seams.ts`,
   which also takes `vfs.ts` back under its size ledger) is where the VFS keeps
   bytes. `vfs-files.ts` lays those seams over any `SecretFiles`:
   `installFileBackedVfs(files)`. The VFS reads synchronously, so the adapter
   keeps a memory mirror; a write completes only once the store has the bytes,
   and a failed write leaves the mirror as it was so the store undoes its edit.
   Two seam additions carry what a file-per-secret layout needs: `writeRaw`
   receives the tomb's key when its caller holds it, and `openBody(tomb, key)`
   lets the layout assemble the body when the vault opens.
4. **Each secret is a file** (`secret-docs.ts`, `layout.ts`,
   `spec/secret-files/`). A vault is
   `<tomb>/vault.json` (the manifest) plus `<tomb>/secrets/<folder>/<name>.<kind>.json`,
   one sealed document per secret. A document is a small declarative envelope
   (`format`, `version`, `kind`) around the vault's own AES-GCM seal, bound to
   the tomb and the **item id**: it cannot be opened under another vault, two
   secrets' files cannot be swapped, and renaming a file by hand is harmless —
   the manifest, not the name, says which file holds which secret. The body the
   store keeps in memory is unchanged, so merge, sync, export and backup are
   untouched; the layout is a way of *resting* it.
   - **A folder is a directory.** Each folder is a small sealed document,
     `folder.dir.json`, in its own directory (a `/` in its name nests), so an
     empty folder is a directory you can see, renaming one moves its directory
     and its secrets' files, and deleting one removes its marker (the empty
     directory itself is left; the contract has no directory removal).
   - **Settings and extension state are documents too.** Every other sealed
     VFS file (a page's preferences, a transport, a drive pairing, a
     connector's settings) is a `config` document: the VFS path and the file's
     language outside, the VFS's own seal inside, at the address its Settings
     page shows it under where it has one (`settings/live/transport.json`) and
     under `config/` where it does not. They stay sealed — editing one by hand
     is not supported, and each page keeps its own language (YAML or JSON); no
     page uses TOML today.
   - **The manifest is the commit point.** A write puts the changed documents
     first and the manifest last (a revision-checked write), then removes what is
     no longer listed. An edit to one secret rewrites that secret's file and the
     manifest, and nothing else.
   - **Reads hold files to the manifest.** A listed file that is missing, does
     not open under this vault and id, or is older than listed (a restored copy)
     is corruption and the vault is not opened; a file one write ahead of the
     manifest is a write that died before it, and is accepted; a file nobody
     listed is ignored, never trusted.
   - **A flat body is still read.** A `body.json` from before this layout, or
     from a writer that has no key (a synced snapshot a device adopts), is read
     when it is further on than the manifest and retired by the next write that
     has the key.
5. **Resilience is one wrapper over any backend** (`resilient.ts`), applied to
   every backend that is not the emulation. An attempt has a time limit; an
   unreachable store is retried a bounded number of times with jittered
   exponential backoff; consecutive failures open a circuit breaker so a dead
   store is not hammered by every keystroke, and one request probes it once it
   has had time. A conflict, a refusal and an absent file are answers and are
   never retried. A write whose answer was lost is confirmed rather than
   guessed at: replacing a file with the same bytes is safe to repeat, and a
   retry that finds its own revision already there is the write succeeding.
6. **Writers race honestly.** The manifest is written with the revision it was
   read at, and checked once before any document is written, so a writer that
   has lost a race finds out before its documents replace the winner's. It fails
   with a conflict, its in-memory change is undone, and the winner's secrets are
   untouched. There is no merge here: merging two devices' bodies is sync's job
   (ADR 0144).
7. **Effect 4 (`effect@4.0.2`, exact) is the implementation language of the
   file layer**: `Context.Service` for the contract, `Effect.gen` and typed
   `Data.TaggedError`s, `Schedule` for backoff, `Semaphore` for the writer,
   `Schema` for the two document formats — and `Schema.toJsonSchemaDocument`
   for the schemas in `spec/secret-files/`, so the definition cannot drift from
   the reader. Promise code stays outside it: `vfs-files.ts` runs one effect per
   seam call and throws the typed error it fails with. `@effect/platform-node-shared`
   is imported only under `src/node/`, the one place `node:*` may be.
8. **The CLI uses real files** (`packages/cli/src/vault-kv.ts` →
   `@opensesame/app-core/node/vault-directory.js`). The vault is
   `<state-dir>/vault/`. A vault an earlier CLI left in `vault-kv.json` is moved
   onto files on first use and the snapshot is kept as `vault-kv.json.migrated`
   (the same ciphertext, a way back). A state directory that already holds a
   vault is never overwritten by an old snapshot.

## What a file shows, and what it does not

A directory necessarily shows what a file system shows: **the folder, the name,
the kind, the size and the timestamps of every secret**. That is a deliberate
exception to ADR 0175's rule that a store of names hides its shape, and it is
the same trade `pass` and the sealed store make, because the point is that a
person can see and manage separate files. What is never in the clear is any
value: every secret, every field and the manifest are sealed, the header holds
only the parameters it always has, and a test scans every file of a real
directory for a canary value and for the master password. The browser's OPFS
emulation keeps hiding shape (ADR 0149, ADR 0175); nothing here changes it.

## Consequences

- **Atomicity is per file, not per vault.** A save that touches several
  secrets and dies after some of their files is not undone; the vault reads
  back with the manifest's listing, accepting files one write ahead, and the
  next save settles it. A failed save forgets what it wrote so the next save
  rewrites every document. Orphans (a new secret's file, written, never listed)
  can remain until that secret is saved again.
- **A document never replaces a file the committed manifest lists for another
  secret**, and replaces its own only if it is still the revision this process
  wrote; a rival's change to the same secret is refused, not overwritten. A save
  that dies after some documents and before its manifest can still show on the
  next open as if it had landed (each file is whole; the vault is not atomic).
- **Leftovers are clutter, not loss, but they can be a deleted secret's sealed
  document.** A removal that fails is not retried, and a `.part` file from an
  interrupted write is hidden, not swept.
- **A stale lock** left by a crashed process is waited out (15 s). Taking over
  a lock two waiters both judged stale is not atomic; the revision check on the
  manifest is what still catches the second writer.
- **A key rotation rewrites every document** (the projection notices the key
  changed) and, like rotation of the flat body before it, is not crash-atomic.
- **Two writers are detected, not merged.** Across processes the lock file and
  the revision check mean exactly one of two creators wins; the loser fails with
  a conflict and must reopen.
- **Names are visible on disk**, as above. A secret named for a customer is a
  file named for a customer.
- **`quality:app-core`**: no static import of the file layer from the VFS; the
  new seams are optional, so Pages and every existing host are unaffected.

## Not in this change

- **Pages' own UI for moving a vault into a bucket.** The shipped PWA keeps
  its OPFS emulation by default and never touches a real filesystem. A bucket
  is an opt-in connection: the `s3` connector (catalog category
  `local_storage`), configured in the Custom setup ceremony's Storage tab
  (contributed by `connectors.external` after its Connectors tab, so it is
  there exactly when Connections is part of the installation) or in Settings ›
  Capabilities › Local storage, and saved device-locally with the secret key
  apart from the public fields. At boot, after the at-rest key and before any
  vault header, `bootCore` asks `hasSavedBucket()` (a small read) and only then
  loads `bucket-boot.ts`, which installs
  `installFileBackedVfs(resilient(makeS3SecretFiles(...)))`. An unreachable or
  half-saved bucket leaves the emulation in place and says so in the tray; it
  never half-installs. The bucket needs a CORS rule for the page's origin that
  allows `If-Match`, `If-None-Match`, `x-amz-*` and `Authorization` and exposes
  `ETag`. What remains is a Settings control to move an existing OPFS vault
  into a bucket.
- **The native plane.** `crates/sealed-store` already keeps one file per entry
  and is not changed. A Rust reader and writer of this layout can be built from
  `spec/secret-files/` and `spec/conformance/secret-file-layout-vectors.json`;
  none exists yet.
- **Per-secret keys.** Every document is sealed under the tomb's key, so
  sharing one means sharing the vault's key or re-sealing it for someone. Giving
  each document its own data key, wrapped to recipients as `pass` and `age` do,
  is what would make a single file shareable as it lies; the envelope's
  `version` is where it would go.
