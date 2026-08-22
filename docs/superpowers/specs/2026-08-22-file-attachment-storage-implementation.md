# One-Shot Implementation Prompt: File Attachment Storage

Audience: an orchestrating LLM coding agent driving parallel subagent swarms
in this repository. This document is self-contained: swarms must not need any
outside conversation or context. Read AGENTS.md before starting; its rules
apply everywhere. There are no phases — every swarm's scope lands in one pass.

## 0. Mission

Users will attach sensitive files (tax-document scans, government IDs) to
OpenSesame. Nothing file-shaped exists in the repo today. Build, in one pass:

1. **Free default tier — "tomb attachments."** Chunked, content-addressed,
   per-chunk-encrypted files stored inside the existing git-native sealed
   store (`crates/sealed-store`), committed and pushed to the user's free
   private git remote through the existing `pass backup` chain. GFS-in-spirit
   (fixed chunks, content addressing, manifest as root of truth) with no new
   services and no cost. Constant memory at GB scale.
2. **Opt-in external tier — "attachment targets."** Org-level target
   configuration through the existing connector ceremony (OAuth connection →
   `PUT` target), with **client-driven** ciphertext replication: the CLI
   pushes sealed bytes through a credential-injecting gateway endpoint
   (Dropbox first), or copies ciphertext to a user-mounted **encrypted disk**
   directory with no gateway involvement.
3. **ADR 0052** recording the options matrix (git-native vs Solid pods vs
   atproto PDS blobs vs IPFS vs gossip/tor vs external-only) and every
   deliberate trade-off named in this document.

### Non-goals (permanent for this change, not deferrals)

- No Pages/PWA in-browser attachment UI or OPFS chunk store (only a warning
  line in the `.1pux` importer — see Swarm F).
- No Box/Google Drive/OneDrive uploaders (target validation accepts only
  providers with an implemented uploader).
- No gateway-side replication actor and no outbox events for attachments:
  the gateway never possesses attachment chunks (the sync plane caps blobs
  at 2 MiB deliberately — `apps/gateway/src/routes/sync.rs:29-41`, comment
  "still bounded so sync is not a file dump").
- No Git LFS (not free). No cross-attachment dedup / convergent encryption
  (equality leak). No stdin attach (chunk count must be known upfront).
- No atproto/Solid implementations (ADR roadmap entries only).
- No changes to the whole-buffer `encrypt_item`/`decrypt_item` API or the
  `.osseal` entry format's existing behavior.

## 1. Repository ground truth (verified; re-verify only if an edit fails)

Toolchain: Rust pinned `1.88` (`cargo +1.88.0 …`), Node ≥ 22, pnpm 9.15.0 via
Corepack, Biome lint, Vitest. Full local gate: `pnpm verify` (changed-file
lint + typecheck/test/integration + `cargo +1.88.0 test --workspace
--all-targets` + `./scripts/battle-test.sh`). No GitHub Actions — keep it
that way.

### Sealed store (`crates/sealed-store`)

- Layout: one `.osseal`/`.gpg`/`.age` file per secret under the store root
  (`OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`);
  wrapped key `.opensesame-key`; anti-rollback map
  `.opensesame-revisions.json` (local-only, never committed).
- `src/envelope.rs`: `OSSEAL_MAGIC = b"OSSEAL1\n"`; `store_ad(name,
  revision)` (line ~16) builds `AssociatedData` with hardcoded
  `organization_id: "local"`, `project_id: "store"`, `collection_id:
  "entries"`, `key_id: "idk"`; `seal_osseal`/`open_osseal` wrap
  `encrypt_item`/`decrypt_item_with_ad`. Legacy branch: `item_id ==
  "sealed-store-entry"` → revision 0.
- `src/git.rs` `auto_commit` (line ~37): `git ls-files -co
  --exclude-standard -z`, then filters to the allowlist at lines ~59-66:
  exactly `.opensesame-key | .opensesame-recipients | .gpg-id |
  .age-recipients` or suffix `.osseal | .gpg | .age`; stages via `git add -A
  -- <paths>`; skips empty commits; warns on missing remote; honors
  `opensesame.autopush`. **Any file type not in this allowlist is silently
  never committed or backed up.**
- `src/path.rs`: `confined_read/confined_write/confined_remove` — openat
  chain, `O_NOFOLLOW`, dirs 0700, files 0600, `sync_all`;
  `logical_to_relative` (validates logical names) / `relative_to_logical`
  (extension strip list at ~:179).
- `src/store.rs`: `ls` walker skips dot-prefixed names and matches only
  `osseal|gpg|age` (~:339); `next_revision` (~:80-98) advances and persists
  the revision map **before** writing new ciphertext; `show` refuses older
  revisions and does `String::from_utf8` (UTF-8-only read path);
  `find_existing` probes `osseal → gpg → age`.
- `src/tomb_registry.rs`: multi-tomb registry (ADR 0038); every CLI verb
  honors `--path` > `--tomb` > env.
- `src/manifest.rs`: Pages plaintext-manifest bridge (`pass seal`).

### Crypto (`crates/human-vault/src/lib.rs`, single file)

- `ENVELOPE_VERSION = 1`; `AssociatedData { envelope_version, item_id,
  organization_id, project_id, collection_id, key_id, revision }`;
  `EncryptedEnvelope` (nonce/ciphertext as base64 Strings); `VaultRootKey`
  / `ItemDataKey` = `[u8;32]`, `Zeroize + ZeroizeOnDrop`; `ad_digest` =
  `"blake3:<hex>"` over canonical `serde_json` of the AD, and that digest
  string is the AEAD AAD; `encrypt_item`/`decrypt_item`/
  `decrypt_item_with_ad` — XChaCha20-Poly1305, random 24-byte nonce,
  whole-buffer. Deps already present: `chacha20poly1305`, `argon2`, `hkdf`
  (SHA-256), `blake3`, `base64`, `zeroize`. **No streaming API exists.**
  Sealed-store sets `ItemDataKey` = VRK bytes (`store.rs:44-45`), collapsing
  the documented VRK→PCK→IDK ladder in `docs/security/key-hierarchy.md`.
- Consumers of this crate: sealed-store, client-core (Wasm re-export), fuzz
  target `fuzz/fuzz_targets/vault_envelope.rs`. Do not change existing
  structs/functions — add only.

### CLI (`apps/cli`)

- `src/main.rs`: `PassCmd` enum at ~:373-564 with sub-enums `PassOtpCmd`
  (~:567) and `PassTombCmd` (~:613); dispatch at ~:805-953.
- `src/store.rs`: `require_reveal(reveal)` at :17-24 — allows if `reveal ||
  stdin is a TTY`, else bails with "plaintext output requires a TTY or
  --reveal; agents must use ConnectionRef invoke". `resolve_root(path,
  tomb)` (~:77), `open_unlocked` (~:94, honors `OPENSESAME_STORE_PASSWORD`),
  `shred_file` (~:314), `is_github_https` + `crate::github::
  resolve_push_token()` for backup credentials (token via env, never argv).

### Agent boundary

- `crates/connector-host/src/providers.rs`: `HumanProviderPlan::SealedStore`
  (~:644) and `execute_sealed_store` (~:1341) — supports only `List` and
  `Read` of entries, returns `String`. Agents must NEVER obtain attachment
  bytes through any surface (ADR 0005/0037).
- WIT (`wit/`) intentionally has no `secrets.get`;
  `crates/connector-sdk` structurally asserts that. No WIT changes needed.

### Connector plane

- Catalog is data: `crates/connection-broker/src/catalog.json` — 85
  providers, revision `"2026-08-12.2"`; strict loader
  `crates/connection-broker/src/catalog.rs` with tests asserting the exact
  provider count and revision (~:641-644). Storage category members:
  `dropbox` (catalog.json ~:418; operations `file.list/read/write`; egress
  authorities include `api.dropboxapi.com` and `content.dropboxapi.com`)
  and `box` (~:466; `api.box.com`, `upload.box.com`). Configuration
  providers `sealed-local` and `encrypted-remote` exist (fields `location`
  + secret `key`). **This change makes no catalog edits.**
- OAuth ceremony (reuse, don't reinvent): `POST /api/v1/connections` →
  `POST /api/v1/connections/{id}/authorize` → `GET
  /api/v1/oauth/callback/{provider}` — `apps/gateway/src/routes/
  connections.rs` + `crates/connection-broker/src/flow.rs` (PKCE S256,
  state TTL 600 s).
- Server egress helper: `ConnectionBroker::authorized_json` in
  `crates/connection-broker/src/egress.rs` — checks connection status,
  `row.egress.allows_url(url)`, opens sealed credential, injects
  `Authorization: Bearer`, returns JSON only; never echoes auth headers.
  Attachments need a **bytes** sibling (Swarm D).
- Target-config idiom to copy: `apps/gateway/src/routes/backup.rs` —
  configurator/operator gate (`middleware/auth.rs` — `require_operator`),
  `#[serde(deny_unknown_fields)]` bodies, upfront validation with 422 codes
  that name the fix (e.g. `integration_unusable`), `DefaultBodyLimit`,
  tenant-safe status responses. Storage rows live in
  `crates/storage/src/lib.rs` (see `BackupTarget`, `upsert_backup_target`);
  SQL migrations under `migrations/` (next free number is `0011`; verify
  with `ls migrations/`).

### Testing conventions

- Four-quadrant "pact" suites (property / adversarial / chaos / contract)
  for security-relevant modules; registry table `docs/validation/pact.md`
  (add a row). Examples: `crates/sealed-store/src/path.rs` tests,
  `crates/human-vault/src/lib.rs` tests.
- Fuzz targets in `fuzz/fuzz_targets/` (mirror `vault_envelope.rs`;
  register in `fuzz/Cargo.toml`).
- Docs: ADRs in `docs/adr/` — next free number is **0052** (verify with
  `ls docs/adr/`; ADR 0038 has three colliding filenames — do not repeat
  that mistake).

### Repo hygiene trap

Session bootstrap hooks may regenerate a duplicate Drizzle migration (e.g.
`packages/database/drizzle/0005_steep_mephisto.sql` duplicating
`0005_audit_seq.sql`). Check `git status` before committing; delete stray
generated duplicates; never commit them.

## 2. Security invariants (normative — every swarm enforces, Swarm H audits)

1. **Only ciphertext leaves the machine.** Chunks and manifests are sealed
   before any commit/replication; the `auto_commit` allowlist stages only
   ciphertext file types; replication endpoints and disk copies move sealed
   bytes as-is; the gateway never sees a store key or plaintext.
2. **No agent byte access.** `connector-host` refuses attachment reads;
   every CLI path that emits plaintext (stdout AND `--out`) goes through
   `require_reveal`.
3. **No equality leak.** Fresh random per-attachment key (HKDF from the
   store key + random attachment id); content addressing is over
   *ciphertext*; identical documents in two attachments produce unrelated
   digests. Deliberate cost: no cross-attachment dedup. Remotes learn only
   sizes/chunk counts (record optional padding as ADR future work).
4. **Anti-rollback.** Attachment manifests ride a dedicated local revision
   map with the same advance-before-write crash ordering as entries; a
   restored older manifest fails closed; `attach rm` leaves a tombstone
   revision.
5. **Path confinement.** All store IO through `confined_*`; manifest
   `filename` is display metadata — sanitized before any filesystem use,
   never used to build store paths.
6. **Fail closed.** Ciphertext digest verified before decrypt; AD verified
   before plaintext release; GC aborts (removing nothing) if any manifest
   fails to open; `attach get` writes via temp file + rename so no partial
   output ever looks complete.
7. **Tokens never in argv or logs**; existing gates (`pnpm audit:ast-grep`,
   `audit:semgrep`, `audit:clippy`) must stay green.

## 3. Normative design specification

Interfaces in §3.9 are **frozen contracts**: swarms code against them
verbatim so they can work in parallel without coordinating. Swarm H resolves
any residual drift at integration.

### 3.1 Chunk frame (`.oschunk`), binary

```
offset  size  field
0       8     magic  b"OSCHNK1\n"
8       24    nonce  (random per chunk)
32      ..    XChaCha20-Poly1305 ciphertext of the plaintext chunk,
              including the 16-byte tag; AAD = chunk_ad_digest(ChunkAd)
```

Overhead 48 B/chunk (~0.005%) versus the ~37% base64-in-JSON blowup of
`.osseal` — the reason chunks get a binary sibling format while manifests
reuse the JSON envelope.

### 3.2 Associated data

`ChunkAd { envelope_version: u32 (== ENVELOPE_VERSION), attachment_id:
String (32 lowercase hex), item_id: String (logical store path),
chunk_index: u32 (0-based), chunk_count: u32 }` → canonical `serde_json` →
`"blake3:<hex>"` digest string (exact `ad_digest` idiom) → AEAD AAD.
`attachment_id` blocks cross-attachment splice; `chunk_index` blocks
reorder; `chunk_count` plus the manifest's totals block truncation and
extension. Deliberate trade-off vs `aead::stream`/age streaming: per-chunk
AD gives the same protections while keeping chunks individually
content-addressable (random access, per-chunk replication) with zero new
dependencies — record in ADR 0052.

### 3.3 Key derivation

`AttachmentKey = HKDF-SHA256(ikm = ItemDataKey bytes, salt = attachment_id
(16 raw random bytes), info = b"opensesame/sealed-store/attachment/v1")`.
Fresh random `attachment_id` per `attach add` ⇒ unique key per attachment
⇒ no nonce-reuse concern across attachments, no equality leak. This is the
first real derivation step toward `docs/security/key-hierarchy.md` — say so
in ADR 0052. All key types `Zeroize + ZeroizeOnDrop`; zeroize plaintext
chunk buffers after sealing.

### 3.4 Store layout

- Chunk objects: `.attachments/objects/<hex[0..2]>/<hex>.oschunk`, where
  `<hex>` = blake3 of the **entire ciphertext frame** (content address).
  Dot-dir keeps them out of the entry walker.
- Manifest: `<logical-path>.osattach`, beside `.osseal` entries. One
  attachment per logical path (pass-idiomatic; a folder of scans is a store
  subtree). An entry and an attachment may share a logical path.
- Attachment revisions: `.opensesame-attachment-revisions.json` — a
  **separate** `BTreeMap<String, u64>` file (same shape/semantics as
  `.opensesame-revisions.json`; local-only; separate to make collision with
  entry names structurally impossible).

### 3.5 Manifest plaintext

UTF-8 JSON — compatible with the UTF-8-only decrypt path — sealed as an
envelope with `collection_id: "attachments"`:

```json
{ "format": 1,
  "attachment_id": "<32-hex>",
  "filename": "w2-2025.pdf",
  "mime": "application/pdf",
  "total_bytes": 1234567,
  "chunk_bytes": 1048576,
  "chunk_count": 2,
  "chunks": [ { "digest": "<blake3-hex-of-frame>", "ct_bytes": 1048624, "pt_bytes": 1048576 },
              { "digest": "<hex>", "ct_bytes": 186087, "pt_bytes": 185991 } ],
  "content_digest": "blake3:<hex of full plaintext>",
  "created_at_unix_ms": 0 }
```

Caps: `filename` ≤ 255 bytes (reject longer); `mime` from an extension map
only (no content sniffing), default `application/octet-stream`.

### 3.6 Constants

`CHUNK_PLAINTEXT_BYTES = 1_048_576` (1 MiB; ciphertext ≈ +48 B, far below
GitHub's 100 MB/file hard limit). `MAX_ATTACHMENT_BYTES = 1 GiB` (= 1024
chunks). CLI warns at ≥ 50 MiB that git remotes have ~5 GB soft repo caps
and suggests an external target. Empty files are valid: `chunk_count: 0`,
`chunks: []`.

### 3.7 Operational semantics

- **add**: requires a regular file (size from fs metadata → `chunk_count`
  known upfront; stream must yield exactly `total_bytes` or fail). Per
  chunk: seal → blake3(frame) → `confined_write` to the object path,
  skipping if the object file already exists (idempotent). Seal + write the
  manifest **last** (the manifest is the commit point), after advancing the
  attachment revision. One `auto_commit(root, "Attach <name>")`. Existing
  name without `--force` → error; with `--force`, new random
  `attachment_id`, old chunks become GC-able orphans.
- **get**: open manifest (revision-checked against the attachment map; if
  the map has no entry, trust the manifest AD's revision — same
  cross-machine fallback as entries — but refuse anything lower than a
  known revision). Per listed digest: `confined_read` → verify
  blake3(frame) == digest **before** decrypt → `open_chunk` with AD rebuilt
  from (attachment_id, name, index, count) → write to sink. Verify running
  totals and final `content_digest`. Any mismatch: fail closed; `--out`
  goes through temp file + rename; default output name =
  sanitized(manifest filename) — strip path separators, refuse `.`/`..`/
  empty after sanitization.
- **ls**: decrypt manifests to summaries; metadata only, never bytes;
  never lists entries, and `pass ls` never lists attachments.
- **rm**: remove the manifest file, advance the revision (tombstone), then
  GC, one commit.
- **gc**: open EVERY `.osattach` manifest in the store; abort — removing
  nothing — if any fails to open. Build the referenced-digest set; remove
  unreferenced `.oschunk` objects **older than a 1-hour mtime grace
  window** (protects a concurrent `add` that has written chunks but not
  yet the manifest); commit `"GC attachments"`.
- **git staging**: batch `git add` invocations (≤ 100 paths each) — a 1 GiB
  attachment stages 1024+ object paths.
- **Deletion is not erasure**: git history retains removed ciphertext and
  the repo only grows. State this plainly in the ADR and in `attach rm`'s
  output; note history-rewrite tooling as explicit future work.

### 3.8 External tier

- **Config**: org-scoped `attachment_targets` row (new table + storage
  fns + migration): `{ organization_id (PK), connection_id, provider_id,
  folder_path, enabled, status, last_error, updated_at_unix_ms }`. Routes
  `GET/PUT/DELETE /api/v1/attachments/target` copy `routes/backup.rs`
  idiom exactly (operator gate, `deny_unknown_fields`, upfront 422s naming
  the fix). PUT accepts only connections whose provider is `dropbox`
  (uploader implemented) — reject others with 422
  `provider_unsupported_for_attachments`. Validate `folder_path` as a
  normalized absolute-ish path (`/a/b`; no `..`, no empty segments). No
  outbox events (nothing consumes them — the gateway holds no chunks).
- **Ceremony** = the existing OAuth connection ceremony, unchanged, then
  the `PUT`. Document the curl sequence in the ADR.
- **Replication endpoints** (session-authenticated via the same
  `resolve_caller` idiom as other routes; org from caller):
  - `POST /api/v1/attachments/replicate/chunk?digest=<hex>` — body =
    raw `.oschunk` frame, `application/octet-stream`, explicit
    `DefaultBodyLimit` of 2,621,440 bytes. Server recomputes blake3 over
    the body and 400s on mismatch with the claimed digest (the gateway
    verifies what it forwards, learning nothing — it's ciphertext). Uploads
    via the bytes egress helper to
    `<folder_path>/objects/<hex[0..2]>/<hex>.oschunk` on the provider
    (Dropbox: `POST https://content.dropboxapi.com/2/files/upload`,
    header `Dropbox-API-Arg: {"path": ..., "mode": "overwrite", "mute":
    true}`, `Content-Type: application/octet-stream` — idempotent by
    construction). Returns `{ "stored": true }`.
  - `POST /api/v1/attachments/replicate/manifest?path=<logical>` — body =
    sealed `.osattach` bytes (≤ 1 MiB); validates the logical path with
    the same character rules as store paths; uploads to
    `<folder_path>/manifests/<logical>.osattach`.
- **Bytes egress helper**: `ConnectionBroker::authorized_bytes` sibling of
  `authorized_json` — same status + `row.egress.allows_url` checks, injects
  the bearer token, sends an octet-stream body, caps the response body it
  reads (64 KiB), never logs/echoes auth material, no redirect following.
- **CLI replication** (`pass attach sync`): passphrase-free — replication
  copies ciphertext as-is (all `.osattach` files + all
  `.attachments/objects/**` present on disk; orphans are harmless
  ciphertext). Two modes:
  - `--to-dir <dir>`: pure local copy of manifests + objects into
    `<dir>/attachments/…` (the "encrypted disk" path — user points it at a
    mounted encrypted volume; no gateway, no ceremony required).
  - default: fetch `GET /api/v1/attachments/target` from the gateway and
    POST each object/manifest to the replicate endpoints. Auth: reuse the
    CLI's existing authenticated-gateway plumbing (inspect how
    `opensesame login`/authenticated verbs store and send the session
    token); token never in argv. Idempotent by digest + overwrite mode; an
    optional local cache `.opensesame-attachment-sync.json` (digest →
    uploaded) may skip re-uploads and is always safe to delete. Nonzero
    exit on any failure; per-item results printed.

### 3.9 Frozen public interfaces (cross-swarm contract — implement verbatim)

`crates/human-vault/src/lib.rs` additions (error type = the crate's existing
crypto error type used by `encrypt_item`):

```rust
pub const OSCHUNK_MAGIC: &[u8; 8] = b"OSCHNK1\n";
pub struct AttachmentKey(pub [u8; 32]); // Zeroize + ZeroizeOnDrop, like ItemDataKey

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct ChunkAd {
    pub envelope_version: u32,
    pub attachment_id: String, // 32 lowercase hex
    pub item_id: String,       // logical store path
    pub chunk_index: u32,
    pub chunk_count: u32,
}

pub fn derive_attachment_key(idk: &ItemDataKey, attachment_id: &[u8; 16]) -> AttachmentKey;
pub fn chunk_ad_digest(ad: &ChunkAd) -> String; // "blake3:<hex>" over canonical serde_json
pub fn seal_chunk(key: &AttachmentKey, plaintext: &[u8], ad: &ChunkAd) -> Result<Vec<u8>, /* existing error */>;
pub fn open_chunk(key: &AttachmentKey, frame: &[u8], ad: &ChunkAd) -> Result<Vec<u8>, /* existing error */>;
```

`crates/sealed-store/src/envelope.rs` additions (existing fns become
thin wrappers over these with `collection_id = "entries"`; the legacy
`sealed-store-entry` branch applies to entries only):

```rust
pub(crate) fn store_ad_in(collection_id: &str, name: &str, revision: u64) -> AssociatedData;
pub fn seal_osseal_in(collection_id: &str, plaintext: &[u8], key: &ItemDataKey, name: &str, revision: u64) -> Result<Vec<u8>, StoreError>;
pub fn open_osseal_in(collection_id: &str, blob: &[u8], key: &ItemDataKey, name: &str, expected_revision: Option<u64>) -> Result<OpenedOsseal, StoreError>;
```

`crates/sealed-store/src/attachment.rs` (new module, re-exported from
`lib.rs`):

```rust
pub const CHUNK_PLAINTEXT_BYTES: usize = 1_048_576;
pub const MAX_ATTACHMENT_BYTES: u64 = 1 << 30;
pub const ATTACHMENT_REVISION_FILE: &str = ".opensesame-attachment-revisions.json";
pub const GC_GRACE_SECONDS: u64 = 3600;

pub struct AttachMeta { pub filename: String, pub mime: Option<String> }

#[derive(Clone, Debug)]
pub struct AttachmentSummary {
    pub name: String, pub attachment_id: String, pub filename: String,
    pub mime: String, pub total_bytes: u64, pub chunk_count: u32,
    pub content_digest: String,
}

pub struct GcOutcome { pub removed: usize, pub kept: usize, pub skipped_recent: usize }

impl StoreRoot {
    pub fn attach_add(&self, name: &str, source: &mut dyn std::io::Read,
        total_bytes: u64, meta: AttachMeta, key: &ItemDataKey, force: bool)
        -> Result<AttachmentSummary, StoreError>;
    pub fn attach_get(&self, name: &str, sink: &mut dyn std::io::Write,
        key: &ItemDataKey) -> Result<AttachmentSummary, StoreError>;
    pub fn attach_ls(&self, prefix: Option<&str>, key: &ItemDataKey)
        -> Result<Vec<AttachmentSummary>, StoreError>;
    pub fn attach_rm(&self, name: &str, key: &ItemDataKey) -> Result<(), StoreError>;
    pub fn attach_gc(&self, key: &ItemDataKey) -> Result<GcOutcome, StoreError>;
    /// Passphrase-free: enumerate ciphertext replication units (all
    /// .osattach files and all object files) as (relative_path, bytes-on-disk path).
    pub fn attach_replication_units(&self) -> Result<Vec<(String, std::path::PathBuf)>, StoreError>;
}
```

CLI surface (`PassAttachCmd`, every variant carries `--path`/`--tomb`):

```
opensesame pass attach add <store-path> <file> [--mime M] [--force] [--shred]
opensesame pass attach get <store-path> [--out FILE] [--reveal]
opensesame pass attach ls [prefix]
opensesame pass attach rm <store-path>
opensesame pass attach gc
opensesame pass attach sync [--to-dir DIR] [--server URL]
```

`attach get` calls `require_reveal(reveal)` unconditionally (stdout AND
`--out`).

Gateway route/DTO names: `AttachmentTargetView`, `PutAttachmentTargetBody
{ connection_id, folder_path, enabled? }` (`deny_unknown_fields`); 422 codes:
`connection_not_found`, `provider_unsupported_for_attachments`,
`invalid_folder_path`. Storage fns: `upsert_attachment_target`,
`get_attachment_target`, `delete_attachment_target` on the existing store
type in `crates/storage/src/lib.rs`.

## 4. Subagent swarms

Ownership is disjoint by file — all swarms run **in parallel**; none may
edit another's files. Each swarm: read AGENTS.md + this document + its owned
files first; write code matching surrounding idiom; add its tests in the
same change; run its own crate/package checks before finishing
(`cargo +1.88.0 test -p <crate>`, `cargo +1.88.0 clippy -p <crate>`,
or `pnpm --filter <pkg> test`). Swarm H runs last and owns integration.

### Swarm A — Chunk crypto (`crates/human-vault/`)

Tasks (atomic):

1. Implement §3.9's human-vault additions exactly (frame per §3.1, AAD per
   §3.2, derivation per §3.3). Reject frames shorter than magic+nonce+tag,
   wrong magic, and `ChunkAd.envelope_version != ENVELOPE_VERSION`.
2. Unit tests: round-trip at sizes 0/1/odd; wrong key, wrong
   attachment_id, wrong item_id, wrong index, wrong count each fail;
   derivation stable per (idk, id) and distinct across ids; truncated and
   bit-flipped frames fail; nonce uniqueness across calls (statistical).

Acceptance: `cargo +1.88.0 test -p opensesame-human-vault` green; no
changes to any existing item/envelope API; new types Zeroize where they
hold key material.

### Swarm B — Sealed-store attachments (`crates/sealed-store/`)

Tasks:

1. `envelope.rs`: add `store_ad_in`/`seal_osseal_in`/`open_osseal_in`
   (§3.9); existing fns delegate with `"entries"`; existing tests untouched
   and passing.
2. New `src/attachment.rs` implementing §3.4–§3.7 with the frozen API; all
   IO via `confined_*`; attachment revision map per §3.4; manifest caps per
   §3.5.
3. `git.rs`: extend the `auto_commit` allowlist with `.osattach` and
   `.oschunk` suffixes; batch `git add` calls at ≤ 100 paths.
4. Ensure `pass ls`/`relative_to_logical` behavior is unchanged for
   entries and that `.osattach`/`.attachments/` never leak into entry
   listings (walker already skips dot-dirs and non-entry extensions — pin
   with tests, adding a parameterized strip variant in `path.rs` only if
   the attachment walker needs it).
5. Pact quadrants in `attachment.rs` `mod pact`:
   - property: round-trip sizes 0, 1, CHUNK−1, CHUNK, CHUNK+1, 3×CHUNK+17;
     `content_digest` stable; idempotent object writes; GC preserves
     exactly the referenced set.
   - adversarial: chunk reorder/truncate/extend, cross-attachment splice,
     bit-flips in frame/nonce/magic, tampered manifest JSON,
     digest-mismatched object, oversized `chunk_count`, path traversal in
     `filename`, restored-older-manifest rollback rejection.
   - chaos: crash between chunk writes and manifest (orphans; store
     consistent; GC reclaims after grace; GC skips young orphans); GC
     aborts wholesale on one unreadable manifest; interleaved add/rm on
     distinct names.
   - contract: golden frame bytes; manifest schema round-trip;
     `auto_commit` stages the new suffixes and still refuses
     plaintext/manifest-json/temp files; `pass ls` excludes attachments.

Acceptance: `cargo +1.88.0 test -p opensesame-sealed-store` green;
allowlist test proves `.oschunk`/`.osattach` are committed and
`.opensesame-attachment-revisions.json` is not.

### Swarm C — CLI verbs (`apps/cli/`)

Tasks:

1. `main.rs`: `PassCmd::Attach { PassAttachCmd }` per §3.9's CLI surface,
   following the `PassOtpCmd`/`PassTombCmd` pattern; dispatch entries.
2. `store.rs`: implement the verbs via `resolve_root` + `open_unlocked`;
   `get` gated by `require_reveal` for stdout and `--out`; `--out` via
   temp+rename with sanitized default filename; `add` warns ≥ 50 MiB;
   `--shred` uses `shred_file`; `rm` output notes git history retains old
   ciphertext.
3. `attach sync`: `--to-dir` local ciphertext copy via
   `attach_replication_units` (no passphrase); gateway mode per §3.8 using
   the CLI's existing authenticated-gateway plumbing (investigate `login`;
   token never in argv); idempotent; nonzero exit on failure.
4. Integration test (temp store + temp git repo): init → attach add →
   `git log`/`ls-files` shows only allowlisted paths staged → attach get
   round-trips byte-identical → piped stdin without `--reveal` refused →
   ls shows metadata → rm → gc → `--to-dir` sync copies exactly the
   ciphertext units → `--tomb` resolution honored.

Acceptance: `cargo +1.88.0 test -p opensesame-cli` green; `--help` output
consistent with existing verb style.

### Swarm D — Gateway external tier

Owns: `apps/gateway/src/routes/attachments.rs` (new), router wiring in
`apps/gateway/src/{main.rs,routes/mod.rs}`,
`crates/connection-broker/src/egress.rs`, `crates/storage/src/lib.rs`,
new `migrations/0011_attachment_targets.sql`.

Tasks:

1. Storage: `AttachmentTarget` row + `upsert/get/delete` fns + migration
   (confirm the next free number via `ls migrations/`), modeled on
   `backup_targets`.
2. `authorized_bytes` in `egress.rs` per §3.8 (egress-allowlisted,
   response-capped, no redirects, no auth echo), with unit tests using the
   crate's existing mock-server idiom.
3. Routes per §3.8: target CRUD (operator gate, 422 codes) and the two
   replicate endpoints (session caller, explicit body limits, server-side
   blake3 verification, Dropbox uploader). Tests: validation matrix,
   oversize body rejected, digest mismatch 400, egress denial surfaces as
   502-class error, auth header never in any response/log, tenant
   isolation (caller org only).

Acceptance: `cargo +1.88.0 test -p opensesame-gateway -p opensesame-storage
-p opensesame-connection-broker` green; no catalog edits; no outbox events.

### Swarm E — Agent boundary + fuzz

Owns: `crates/connector-host/src/providers.rs`, `fuzz/`.

Tasks:

1. `execute_sealed_store`: explicit refusal (`Unsupported("sealed-store
   attachments are human-only")`) for any attachment-shaped access; test
   pinning that a name with only `.osattach` remains unreadable via every
   provider operation, today and via the new guard.
2. New `fuzz/fuzz_targets/attachment_chunk.rs` (+ `fuzz/Cargo.toml`
   `[[bin]]`): arbitrary bytes → frame parse + `open_chunk` with a fixed
   key + manifest JSON parse — must error, never panic/OOM; mirror
   `vault_envelope.rs` structure. `cargo fuzz build` must succeed.

Acceptance: both compile and tests pass; short local fuzz pass finds
nothing.

### Swarm F — Docs & client notice

Owns: `docs/adr/0052-file-attachment-storage.md` (new),
`docs/adr/0038-sealed-store-backup-github-app.md`,
`docs/validation/pact.md`, `AGENTS.md`,
`apps/pages/src/lib/vault/import/zip.ts`.

Tasks:

1. ADR 0052: context; options matrix with verdicts — git-native chunked
   ciphertext (chosen: free private remotes, offline-first, rides ADR
   0037/0038 fabric, E2EE preserved), Solid pods & atproto PDS blobs
   (roadmap connectors; ciphertext-only makes their public-ish blob
   semantics tolerable; no free durable guarantees today), IPFS pinning /
   gossip / tor (rejected: no free durable capacity, NIH transport
   contradicts ADR 0008, availability of tax documents must not depend on
   peer goodwill), external-only (rejected: not free). Record: §3 formats
   and constants, key derivation, STREAM-vs-per-chunk-AD trade-off,
   no-convergent-encryption rationale, deletion-≠-erasure and repo-growth
   honesty, free-tier ceiling and the external-target escape hatch,
   client-driven replication rationale (gateway never holds chunks),
   encrypted-disk `--to-dir` mode, ceremony curl walkthrough.
2. ADR 0038 (backup file): amend the committed-artifact list with
   `.osattach` + `.attachments/**/*.oschunk`, pointing at ADR 0052.
3. `docs/validation/pact.md`: add the "Sealed-store attachments" row.
4. `AGENTS.md` §3 crib sheet: `pass attach` examples under the sealed-store
   block.
5. `zip.ts`: when a `.1pux` archive contains entries that are skipped,
   surface a warning that attachments in the archive were not imported and
   can be added via `opensesame pass attach`. One warning path + its unit
   test — no importer behavior change.

Acceptance: `pnpm --filter @opensesame/pages test` green; markdown lint
clean.

### Swarm H — Integration & validation

Runs after A–F; owns no files exclusively; may touch any file to resolve
drift.

Tasks:

1. Resolve interface drift against §3.9 (frozen signatures win unless a
   compile error proves the doc wrong — then fix minimally and note it in
   the PR body).
2. Full gates: `pnpm verify`; `pnpm audit:clippy`; `pnpm audit:ast-grep`;
   `pnpm audit:semgrep`; `cargo fuzz build`; targeted
   `cargo +1.88.0 test --workspace --all-targets`.
3. End-to-end scenario on a throwaway store: init → attach a multi-chunk
   file → clone the store repo to a second directory → unlock with the
   same passphrase → `attach get` round-trips byte-identical → tamper one
   object file in the clone → `attach get` fails closed.
4. Adversarial checklist (§6) — verify every line, fix or document.
5. Repo hygiene: remove stray generated files (e.g. duplicate drizzle
   migrations) before committing. Commit with clear messages; push the
   assigned feature branch; open a ready-for-review PR whose body lists:
   formats, invariants, gates run with results, and the §6 checklist
   outcomes.

## 5. Conductor protocol

1. Spawn Swarms A, B, C, D, E, F concurrently (disjoint files; frozen
   interfaces in §3.9 mean no swarm waits on another's output).
2. Each swarm self-verifies its own crate/package before reporting done.
3. Then run Swarm H once, to completion (compile, gates, e2e, checklist,
   commit, push, PR).
4. If any swarm fails irrecoverably, fix forward within its file ownership
   — do not silently narrow scope; a genuine scope cut must be listed in
   the PR body under "Deviations".

## 6. Adversarial review checklist (Swarm H verifies each)

- [ ] A `.oschunk`/`.osattach` file written by `attach add` appears in the
      next commit (allowlist amended) and
      `.opensesame-attachment-revisions.json` never does.
- [ ] `pass ls` output is unchanged for a store that also contains
      attachments; `attach ls` never shows entries.
- [ ] Piped (non-TTY) `pass attach get` without `--reveal` exits nonzero
      with no bytes written, for stdout and `--out` alike.
- [ ] connector-host cannot read attachment bytes or manifests via any
      provider operation.
- [ ] Chunk reorder, truncation, extension, cross-attachment splice, and
      restored-older-manifest each fail closed with distinct errors.
- [ ] Two attachments of the identical file share zero object digests.
- [ ] `attach gc` with one undecryptable manifest removes nothing; young
      orphans (< 1 h) survive GC.
- [ ] Replicate endpoints reject: oversize bodies, digest mismatches,
      non-configured targets, other-org callers; responses and logs never
      contain Authorization material.
- [ ] `authorized_bytes` refuses URLs outside the connection's egress
      authorities and follows no redirects.
- [ ] `--to-dir` sync copies only ciphertext units; no plaintext, no key
      files' plaintext, no revision maps required.
- [ ] No new dependency was added to any crate without justification in
      the PR body; `pnpm audit:cargo-audit` unaffected.
- [ ] `store_ad_in` refactor leaves every existing `.osseal` readable
      (legacy + bound forms) — existing envelope tests untouched and green.
