# ADR 0063 — Encrypted VFS for vault + config; every vault is a tomb

Status: Accepted
Date: 2026-08-29
References: ADR 0038 (personal project binding), ADR 0039 (server-side
backup), ADR 0041 (projects, sync targets, changelog), ADR 0054
(file-attachment storage), competitor references
[`docs/competitors/tomb.md`](../competitors/tomb.md),
[`docs/competitors/pass.md`](../competitors/pass.md)

## Context

The Pages vault is already zero-knowledge at the item level: the vault body
is one AES-GCM-sealed blob in OPFS, only ciphertext ever leaves the device
(`lib/vault/crypto.ts`, `lib/vault/host-backup.ts`), and git persistence is
Host-mediated ciphertext push (ADR 0039). But the surrounding architecture
doesn't match the stated model:

1. **Storage is flat KV, not a filesystem.** OPFS files are flat
   `opensesame-pages-<key>.json` strings (`lib/kv.ts`); there is no
   directory model, no tomb namespace, no per-vault volume concept.
2. **Config lives in plaintext.** Endpoints, vault prefs, the project list,
   and the IdP registry sit in plaintext OPFS/localStorage
   (`lib/settings.ts`, `store.ts` prefs, `lib/projects.ts`,
   `lib/idp-registry.ts`). "Vault items **and config** in an encrypted VFS"
   they are not.
3. **The vault is not framed as a tomb.** The sealed-store world has a
   multi-tomb registry with key separation (`crates/sealed-store/src/tomb_registry.rs`);
   the browser vault has the same shape implicitly (project-scoped vaults,
   separately wrapped keys) but no explicit tomb model.

## Decision

**An encrypted VFS browser-side** (`apps/pages/src/lib/vfs.ts`):

- Path-addressed storage: `tomb/<name>/body`, `tomb/<name>/config/*`,
  `tomb/<name>/drops/*` — every file's content sealed (AES-GCM under the
  tomb's vault key, the existing `SealedBlob` construction). A per-tomb
  directory index is itself a sealed file; a plaintext top-level registry
  lists only tomb *names* (the analog of `tombs.json` — names are not
  secrets, contents are).
- Each vault **is a tomb**: a named volume with its own vault key, its own
  sealed body, its own config area — the `pass` CLI tomb treatment
  browser-side. Project-scoped vault keys (`scopedKey`) map 1:1 to tombs;
  the personal vault is the `personal` tomb (ADR 0038).
- **Config moves into the sealed VFS**: vault prefs, the IdP registry
  (leaves localStorage), project list, org profile, drop records — migrated
  on unlock (read legacy plaintext store → write sealed → delete legacy).
  **Boot config stays plaintext by design**: Identity/Host endpoints are
  needed pre-unlock to reach anything, and they are non-secret public
  parameters — the same posture as the vault header (KDF params), and the
  same thing `pass` does (the store path is not encrypted). This is a
  documented boundary, not a leak.
- **Git persistence stays Host-mediated** (ADR 0039): the browser pushes
  sealed VFS files (ciphertext only, as today); the Host's backup actor
  commits them to the configured git remote. **No git client or git
  credentials in the browser** — that would weaken zero-knowledge, not
  strengthen it. Browser-direct git is a deliberate non-goal.
- Key separation is preserved exactly as today: tomb keys are wrapped by
  unlock enrollments (passkey PRF / PIN / password) and never leave the
  device — the passthrough/zero-knowledge invariant.

### Deliberate non-goals

- No browser implementation of age/per-recipient tomb encryption — the
  browser tomb uses the vault's AES-GCM sealing; the `pass` CLI tomb stays
  the age/git-native form, bridged as today (`pass seal` / sync blobs).
- No IndexedDB/localStorage for vault or config (ast-grep bans localStorage
  for vault material; the VFS lives in OPFS with the existing memory
  fallback).

## Consequences

- One storage abstraction (`lib/vfs.ts`) replaces ad-hoc KV keys for vault
  content and config; new features (drops, per-tomb settings) get sealed
  paths by default instead of new plaintext keys.
- The plaintext surface shrinks to: boot endpoints, vault header (public
  params), lockout counters, tomb names. Everything else is sealed at rest.
- "Each vault is a tomb" becomes literal in the storage layout and the UI
  vocabulary (vault switcher already lists project vaults; they are tombs).
- Git backup requires no new machinery — the same ciphertext push carries
  sealed VFS files; the zero-knowledge story is unchanged and auditable in
  one place.
