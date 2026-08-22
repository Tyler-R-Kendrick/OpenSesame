# OpenSesame Security Program — One-Shot Subagent Swarm Brief

You are an orchestrating LLM coding agent operating on the OpenSesame
repository. This document is your complete, self-contained instruction set.
Do not defer to any prior conversation. Every fact you need — file paths,
line anchors, type names, crypto parameters, wire formats — is embedded here.
Where a line number has drifted, locate the anchor by the quoted code, not
the number.

## 0. Mission

Implement five security priorities in one coordinated pass, using parallel
subagents:

1. **TOTP/2FA import/export** — full portability of authenticator secrets.
2. **Account recovery** — an ADR evaluating all options (pros/cons), plus the
   accepted baseline implemented end-to-end.
3. **Metadata hardening** — no unencrypted or non-anonymized metadata
   anywhere ciphertext travels. This is the anti-LastPass mandate: in the
   2022 LastPass breach, stolen vault blobs contained plaintext website URLs
   and folder names (letting attackers triage victims for targeted phishing
   and crypto theft), and legacy accounts had PBKDF2 iteration counts as low
   as 1. Encrypt everything; version and bound KDF params.
4. **Zero-knowledge philosophy** — the server must never hold or learn key
   material, item names, folder names, or URLs. Repo invariant: "Valid OIDC
   session ≠ possession of VRK."
5. **Breach monitoring** — HaveIBeenPwned k-anonymity password checks,
   client-side and opt-in, plus a design ADR for server-side email breach
   monitoring.

## 0.1 Already landed — do not redo

These were found while drafting this brief and fixed on the branch stack
before it was handed over. Verify each is present, then treat it as done:

- **control-plane TOTP enrollment URI** now emits an RFC 4648 base32 secret
  (`base32Encode` in `apps/control-plane/src/routes/mfa.ts`), with a fence in
  `src/__tests__/mfa-totp-uri.test.ts`. T5 below is complete.
- **sealed-store commit subjects** are name-free (`COMMIT_ADD`/`COMMIT_EDIT`/
  `COMMIT_REMOVE`/`COMMIT_REBIND` in `crates/sealed-store/src/store.rs`), with
  a plant-name fence over `git log`. The §3.4 half of M1 is complete; the
  blinded-path/AD work (§3.3) is NOT.
- **`storePathToSyncBlobId` is deleted** along with its tests. M5 is complete.
- **`contract_envelopes_are_ciphertext_only`** is renamed to
  `contract_envelope_payload_is_ciphertext_only`, and a companion
  `characterize_associated_data_is_cleartext_today` pins the cleartext AD with
  distinctive sentinels. When §3.3 lands, invert that characterization test
  into an absence assertion rather than deleting it.
- **`scripts/jazzer-gate.sh`** distinguishes a coverage-guided pass from the
  random-input fallback and honors `JAZZER_REQUIRE_NATIVE=1`.
- **The vendored anti-slop suites** under `tools/oxlint/anti-slop` now run via
  `packages/testing/src/anti-slop-rules.test.ts`.

## 1. Repository law (binding on every subagent)

- Toolchain: Node ≥ 22, pnpm 9.15.0 via Corepack, Rust pinned `1.88`
  (`cargo +1.88.0 …`), Biome lint (2-space indent), Vitest for TS, Turbo.
- Verification: there is NO CI. Local gates only. Full gate:
  `pnpm verify` (changed-file lint + typecheck + all TS tests + integration +
  `cargo +1.88.0 test --workspace --all-targets` + `./scripts/battle-test.sh`).
  Crypto/auth-touching changes additionally run `pnpm audit:ast-grep`,
  `pnpm audit:semgrep`, `pnpm audit:clippy`; new npm deps run
  `pnpm audit:osv` and `pnpm audit:cve-lite`.
- ADRs for consequential decisions live in `docs/adr/`. This program creates
  three, referred to below as **ADR-RECOVERY**, **ADR-BLINDED-STORE** and
  **ADR-BREACH**. **Do not hardcode their numbers from this document.**
  Allocate them at implementation time by running `ls docs/adr/` and taking
  the next free numbers in that order, because several unmerged branches are
  each claiming the same next number: `0052` is already taken on the
  passkey-portability branch, and at least one other brief instructs an agent
  to create its own `0052`. The directory also already carries three files
  numbered `0038` and has no `0040` — that is the mistake to avoid repeating,
  not to copy. Record the numbers you allocated in the PR body, and
  cross-reference by filename rather than number wherever practical.
  Found-and-fixed security issues get a
  dated `docs/security/audit-2026-08-22-<topic>.md` (append a new file; never
  edit history).
- `packages/os-domain` must NOT import Better Auth, oidc-provider, Hono,
  Drizzle, or React.
- Honest Crypto Rule (`DESIGN.md`): every claim the UI makes must be true in
  the code. When behavior changes, the copy changes in the same commit.
- Never expose raw secrets or a `getSecret()` affordance; no `sudo`; never
  commit live secrets.
- Branch: `claude/2fa-account-recovery-security-oz3r2b`. Commit messages are
  clear and descriptive; NO model identifiers in commits, PR titles/bodies,
  or code comments. Push with `git push -u origin <branch>`; open one PR
  (ready, not draft) if none exists; end the PR body with the Claude Code
  attribution footer (blank line, `---`, `_Generated by [Claude Code](https://claude.ai/code)_`).
- An untracked `packages/database/drizzle/0005_steep_mephisto.sql` may exist
  from session bootstrap (`drizzle-kit generate` ran with "No schema changes").
  The integration agent inspects it: if it is an empty/no-op regeneration
  artifact, delete it; if it contains real DDL matching the checked-in schema
  journal, commit it separately with an explanatory message.

## 2. Architecture context (read once, applies to all swarms)

Two independent crypto stacks exist. Do not conflate them:

**TS/browser vault** (`apps/pages` — the offline "authority vault" PWA):
- `apps/pages/src/lib/vault/crypto.ts`: master password → PBKDF2-HMAC-SHA256
  (`PBKDF2_ITERATIONS = 600_000`, `MAX_PBKDF2_ITERATIONS = 10_000_000`,
  `SALT_BYTES = 16`) → MK; MK AES-256-GCM-wraps a random 256-bit vault key
  (VK); VK seals the whole `VaultBody` as one blob (`sealJson`/`openJson`,
  `SealedBlob { ivB64, ctB64 }`). Cleartext `VaultHeader { v, kdf, wrap,
  unlocks, createdAt, hint?, bodyRev }`. `assertKdfParams` (≈line 129)
  enforces the iteration band — LastPass-style legacy rot is already fenced.
- `apps/pages/src/lib/vault/unlock-methods.ts`: multi-wrap seam.
  `VaultUnlocks = { passkey?: PasskeyUnlockRecord; pin?: PinUnlockRecord;
  totp?: TotpGateRecord }` (line ≈60), `UnlockMethodId = "password" |
  "passkey" | "pin"` (line ≈66), `wrapVaultKeyWithPin` (PBKDF2 1_200_000),
  `wrapVaultKeyWithPrf`/`unwrapVaultKeyWithPrf`, `kekFromWebauthnPrf` (HKDF
  info `"opensesame/vault/webauthn-prf/v1"`), `exportRawVaultKey`,
  `assertKeepsPrimaryUnlock` (cannot delete the last primary unlock).
- `apps/pages/src/lib/vault/model.ts`: `ItemKind = "login" | "passkey" |
  "card" | "secret" | "note" | "certificate"`; `LoginItem.totp: string`
  ("Base32 TOTP seed, or an otpauth:// URI; empty when no 2FA"); `VaultBody
  { v: 1, items, folders, rev }`; all names/URLs/folders live INSIDE the
  sealed body (already zero-knowledge-clean).
- `apps/pages/src/lib/vault/store.ts` (~1143 lines): OPFS-backed sealed
  store; `exportSealed()` ≈line 1020, `importSealed()` ≈line 1038; persistence
  pushes ciphertext to host (`host-backup.ts`, blob ids `vault:header` /
  `vault:body` — safe).
- TOTP engine: `apps/pages/src/lib/vault/totp.ts` — `parseTotp` (accepts bare
  base32 or `otpauth://` URI), `totpCode`, `secondsRemaining`,
  `totpSetupUri(raw, {label, issuer})`, `decodeBase32`, seam object
  `totpSeams`. UI `components/TotpCode.tsx`; QR shown in
  `sections/vault/ItemDetail.tsx` (≈507–550); edit field in
  `sections/vault/ItemEditor.tsx` (≈309).
- Import pipeline: `apps/pages/src/lib/vault/import/` — `index.ts` holds the
  `ADAPTERS` detection chain; `types.ts` holds `SourceId`, `DraftItem`/
  `DraftLogin` (with `totp: string`), `ImportAdapter`, and `normaliseTotp(raw)`
  (≈line 187, the canonical TOTP normalizer). Format adapters live in
  `import/formats/` (bitwarden, onepassword, protonpass, browsers, managers,
  env). UI: `sections/settings/ImportPanel.tsx`.
- QR: `packages/qr` exports `encodeQrSvg`, `encodeQrTerminal`, `encodeQrSize`.
  ENCODE ONLY — there is no QR decoder in the repo.
- Health: `apps/pages/src/lib/vault/health.ts` — `HealthIssue = "weak" |
  "reused" | "old" | "no-2fa"`, pure `buildHealthReport(items)`,
  `ISSUE_LABEL`/`ISSUE_EXPLANATION` maps. UI `sections/vault/HealthPanel.tsx`
  — lines ≈36–40 currently promise "No password, and no hash of one, leaves
  this device — this report never contacts a breach service."
- Connectivity: `apps/pages/src/lib/connectivity-monitor.ts` — the single
  supervisor for reachability probes (do not add independent timers).
- CSP: `apps/pages/index.html` line ≈13 already has
  `connect-src 'self' data: http: https: ws: wss:` — outbound HTTPS is NOT
  blocked; do not "fix" CSP unless a service worker fetch allowlist actually
  intercepts (verify before changing anything).

**Rust plane**:
- `crates/human-vault/src/lib.rs` (crate `opensesame-human-vault`):
  Argon2id v0x13 (write params m=64 MiB, t=3, p=1; accepted band
  MIN_ARGON_M_KIB=65536, MAX=1048576, MIN_T=3, MAX_T=16, MAX_P=4, enforced by
  `assert_argon_params_accepted`) → HKDF-SHA256 (info
  `b"opensesame/vault/vrk-wrap/v1"`) → KEK; XChaCha20-Poly1305 (24-byte
  nonce); AAD = blake3 digest of serialized `AssociatedData { envelope_version,
  item_id, organization_id, project_id, collection_id, key_id, revision }`.
  Types: `VaultRootKey`, `ItemDataKey` (Zeroize), `EncryptedEnvelope
  { version, nonce, ciphertext, ad, ad_digest }` — NOTE: `ad` is serialized
  IN THE CLEAR next to the ciphertext. Fns: `encrypt_item`, `decrypt_item`,
  `wrap_vrk_with_password`, `unwrap_vrk_with_password`,
  `kek_from_webauthn_prf(prf_output, public_salt)`. There is NO
  `wrap_vrk_with_recovery_key`.
- `crates/sealed-store` (crate `opensesame-sealed-store`) — git-native
  pass-parity store:
  - `path.rs` `logical_to_relative()`: logical name `Dev/api-token` maps to
    plaintext path `Dev/api-token.osseal` (folder = directory). LEAK.
  - `store.rs`: commit messages embed names — line ≈156 `Add {name}`, ≈170/174
    `Edit {name}`/`Add {name}`, ≈253 & ≈293 `Bind {name} encryption context`,
    ≈304 `Remove {name}`. LEAK (backup repo history reads
    `Add Email/github.com` with timestamps). Listing/prefix walk at ≈347.
  - `manifest.rs` ≈72: manifest seal commit message; `ManifestEntry { path,
    secret, trailer }`, `seal_manifest` (TOTP survives via trailer).
  - `envelope.rs`: `.osseal` container (`OSSEAL_MAGIC = b"OSSEAL1\n"` + JSON
    `EncryptedEnvelope`); `store_ad()` (≈line 16) sets `item_id: name` — the
    logical path is ALSO cleartext inside every `.osseal` file. LEAK. AD pins
    `organization_id: "local"`, `project_id: "store"`, `collection_id:
    "entries"`, `key_id: "idk"`, `item_id = name`.
  - `otp.rs`: full RFC 6238 (`parse_otpauth`, `totp_code`, trailer sync);
    HOTP parses but does not generate.
  - `entry.rs`: `Entry { secret, trailer, otp: Option<OtpUri> }` — URLs,
    usernames, otpauth URIs are inside the ciphertext (only names/paths leak).
  - Pact test `contract_envelopes_are_ciphertext_only` (human-vault ≈line
    638) asserts payload absence but NOT `ad` opacity.
- CLI `apps/cli` (binary `opensesame`): `pass` verbs incl. `pass otp {code,
  insert, append, uri, validate}` — `PassOtpCmd` at `src/main.rs` ≈567,
  handlers in `src/store.rs` (`cmd_otp_uri` ≈466). `pass otp uri` ALREADY
  EXISTS — do not re-add it.
- Gateway `apps/gateway` (crate `opensesame-gateway`):
  - `src/backup.rs` — event-driven GitHub backup actor (ADR 0039).
    `snapshot()` ≈line 252 builds the repo tree with
    `let path_component = |value: &str| URL_SAFE_NO_PAD.encode(value.as_bytes());`
    — reversible base64, not blinding. Tree: `connections/{b64(id)}.json`,
    `sync/{b64(owner)}/{b64(blob)}.json`, `vault/{b64(vault)}/{b64(item)}/{rev}.json`;
    file bodies echo ids plaintext. LEAK.
  - `src/routes/sync_blobs.rs` — host stores `{id, epoch, ciphertext}` only;
    `project_scoped()` (≈157) prefix-matches `project:{id}:` on blob ids.
- `apps/pages/src/lib/vault/store-sync.ts` — Pages↔store bridge
  (`entryToVaultItem`, `vaultItemToEntry`, `planManifestMerge`).
  `storePathToSyncBlobId` (≈line 323) returns
  `project:{id}:Email/github.com` — a plaintext path as an "opaque" sync id.
  Dead code (referenced only by `store-sync.test.ts` ≈96). Remove it.
- Audit/observability: `packages/audit/src/redact.ts` line ≈11 — metadata
  allowlist ADMITS `path`, `keyNames`, `slug`, `environment`, `issuer`,
  `subject`. Read these carefully before treating any of them as a leak:
  `path` sits beside `method` and `statusCode`, so it is the HTTP request
  path, not a secret store path — digesting it would cost audit legibility
  for no confidentiality gain. `keyNames` is the real candidate (secret key
  names, admitted by the string-array branch at ≈110-116), together with
  `outbox_events.payload.store_path`, which rides → NATS → worker logs via
  `apps/worker/src/rotation.ts` ≈88 `RotationJobView.storePath`. Confirm
  each value's provenance at the call site before changing the allowlist.
  Blinding primitives that already exist: `packages/os-domain/src/crypto/digest.ts`
  (`sha256Hex`, `canonicalize`) and `packages/os-domain/src/crypto/claim-token.ts`
  (`hmacDigest` — peppered, purpose-domain-separated).
- Recovery landscape: NOTHING exists. `DESIGN.md` L95/L131/L209 state the
  **No-Recovery Rule** ("The absence of a recovery path is stated before the
  vault is created, acknowledged with a checkbox… Never soften it"), enforced
  by a required checkbox in `apps/pages/src/screens/UnlockScreen.tsx` ≈532–543
  ("I understand this vault cannot be recovered."). L209 is already stale
  (PIN and passkey unlocks exist). BUT `docs/security/key-hierarchy.md`
  (26 lines) sanctions "Recovery key → KEK" as a VRK wrapper — declared,
  unimplemented. `packages/recovery-graph` (`@opensesame/recovery-graph`) is
  a fully-tested, dependency-free, ORPHANED analyzer (`validateRecoveryGraph`,
  `analyzeCycles`, `findArticulationPoints`, `calculateIndependentRoots`;
  node kinds incl. `recovery_code`, `trusted_contact`; issue kinds
  `benign_redundancy`/`hard_recovery_cycle`) — no consumers anywhere.
- Identity plane (`apps/control-plane`, Hono + Better Auth + oidc-provider):
  Better Auth runs `emailAndPassword: false`, `accountLinking: false`, zero
  plugins; no reset/magic-link/backup-code endpoints; email deliberately
  non-authoritative. MFA is hand-rolled in `src/routes/mfa.ts`: WebAuthn real;
  TOTP enroll/verify DEV-ONLY (403 `totp_dev_only` unless dev defaults).
  BUG at `mfa.ts` ≈362: the enroll otpauth URI embeds the secret as HEX;
  RFC-compatible authenticators require Base32.
- Breach monitoring: zero HIBP/k-anonymity code anywhere.
- Server-side backup restore path: re-enter an unlock (password/passkey/PIN),
  pull ciphertext. Server structurally refuses to wrap client blobs
  (`refuseDeploymentSealWrap` in `offline-backup.ts`,
  `refuse_deployment_seal_as_wrap_key` in `crates/client-core/src/snapshot.rs`).

## 3. Shared contracts (FROZEN — all subagents implement exactly this)

These interfaces let independent agents converge without coordination. Do
not deviate; do not "improve" them mid-flight.

### 3.1 Recovery key wire format (TS and Rust identical)

- Raw material: 32 cryptographically random bytes (`crypto.getRandomValues` /
  `OsRng`).
- Encoded payload: `0x01` version byte ‖ 32 key bytes ‖ 1 checksum byte,
  where checksum = first byte of SHA-256(version byte ‖ key bytes).
  34 bytes → Crockford Base32 (uppercase, no padding) → 55 characters.
- Display form: `OSRK-` prefix, then the 55 chars in `-`-separated groups of
  5 (last group 5 chars exactly: 55 = 11×5). Parsing strips the prefix,
  dashes, whitespace, and lowercases-then-normalizes per Crockford (I/L→1,
  O→0); rejects wrong version or checksum with a distinct error.
- KDF: HKDF-SHA-256, IKM = the 32 key bytes, salt = 16 random bytes stored
  in the record, info = `"opensesame/vault/recovery-key/v1"`, L = 32 → KEK.
- TS record (added to `VaultUnlocks`):
  `recovery?: { saltB64: string; wrap: SealedBlob; verifierB64: string;
  createdAtIso: string }` where `wrap` = VK sealed under the KEK with
  AES-256-GCM (reuse the existing PIN/PRF sealing helpers) and
  `verifierB64` = base64 of the first 8 bytes of
  SHA-256(`"opensesame/vault/recovery-verifier/v1"` ‖ salt bytes ‖ key bytes).
  The verifier exists so the UI can say "wrong recovery key" distinctly;
  8 bytes of a hash of a 256-bit uniform key enables no feasible brute force.
- Rust parity (`opensesame-human-vault`): `RecoveryWrapper` struct +
  `wrap_vrk_with_recovery_key(key: &[u8; 32], vrk) -> RecoveryWrapper` /
  `unwrap_vrk_with_recovery_key` using the same HKDF info string and salt
  handling; cipher follows the plane's convention (XChaCha20-Poly1305, like
  `PasswordWrapper`). Parity = identical OSRK format, KDF, info string,
  verifier; cipher differs per plane by design.
- Recovery is an EMERGENCY wrap, not a daily unlock: it is NOT added to
  `UnlockMethodId`, NOT returned by `listAvailableUnlockMethods`, and NOT
  counted by `assertKeepsPrimaryUnlock` (a vault whose only wrap is paper is
  a failure mode).

### 3.2 Google Authenticator migration protobuf (`MigrationPayload`)

Message schema (proto3 wire format, hand-rolled codec, zero dependencies):

```
message MigrationPayload {              // otpauth-migration://offline?data=<base64(payload)>
  repeated OtpParameters otp_parameters = 1;
  int32 version = 2;                    // 1
  int32 batch_size = 3;                 // total QR count
  int32 batch_index = 4;                // 0-based
  int32 batch_id = 5;                   // random, same across batches
}
message OtpParameters {
  bytes  secret    = 1;                 // RAW key bytes (not base32 text)
  string name      = 2;                 // "Issuer:account" or account
  string issuer    = 3;
  Algorithm algorithm = 4;              // 0 UNSPEC, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5
  DigitCount digits = 5;                // 0 UNSPEC, 1 SIX, 2 EIGHT
  OtpType type     = 6;                 // 0 UNSPEC, 1 HOTP, 2 TOTP
  uint64 counter   = 7;                 // HOTP only
}
```

Codec module: `apps/pages/src/lib/vault/import/otpauth-migration.ts`
exporting exactly:
`decodeMigrationUri(uri: string): { entries: MigrationEntry[]; batchIndex: number; batchSize: number }`,
`encodeMigrationUris(entries: MigrationEntry[], perBatch?: number): string[]`
(default 10/batch), and
`type MigrationEntry = { secret: Uint8Array; name: string; issuer: string;
algorithm: "SHA1"|"SHA256"|"SHA512"; digits: 6|8; type: "totp"|"hotp";
counter?: number }`.
Base64 in the `data=` query param may arrive URL-encoded and/or with `+`→` `
mangling — normalize before decode. Malformed input returns a typed error
result (never an uncontrolled throw). HOTP entries decode but importers skip
them with a per-entry warning (the vault has no HOTP counter support).

### 3.3 Blinded sealed-store layout (v2)

- `path_key` = `blake3::derive_key("opensesame sealed-store path-blind v1",
  <store root key bytes>)` — the same key material the store's envelope
  sealing already uses; derivation context string frozen as written.
- Blinded relative path for logical name N:
  `h = blake3::keyed_hash(path_key, N_utf8)`; take the first 20 bytes,
  encode lowercase Crockford Base32 (32 chars); layout
  `bl/<first 2 chars>/<remaining 30 chars>.osseal`. Deterministic →
  idempotent writes and point lookups without the index.
- Sealed name index: a single additional encrypted entry at the fixed path
  `bl/index.osseal` whose plaintext is JSON
  `{ v: 1, entries: { "<logical name>": "<blinded relpath>" } }`, updated in
  the same commit as any mutation. `ls`/`find`/prefix operations read the
  index. A stolen repo shows only uniform blobs.
- `AssociatedData.item_id` for v2 entries = the 32-char blinded id (NOT the
  logical name) — preserves anti-transplant binding without cleartext names.
  The index entry's own AD uses `item_id: "__index__"`.
- v1 stores (plaintext paths) remain readable/writable; detection = presence
  of `bl/index.osseal` (or `.osseal-v2` marker written by init/migrate).
  `opensesame pass migrate --blind` converts a v1 store in one commit.
  New `pass init` defaults to v2. gpg/age passthrough entries cannot be
  blinded (external tools address paths) — documented limitation.
- All commit messages become name-free (see 3.4).

### 3.4 Name-free commit messages (sealed-store)

`seal: add entry`, `seal: edit entry`, `seal: remove entry`,
`seal: rebind entry`, `seal: manifest (N entries)` (count only). Nothing
else from the entry may appear.

### 3.5 Blinded gateway backup tree

Digest key = HKDF-SHA-256(deployment seal key material, info =
`"opensesame/backup/path-blind/v1"`) — this HASHES identifiers; it does not
wrap client blobs, so it does not violate the deployment-seal prohibition.
`path_component(value)` = first 16 bytes of HMAC-SHA-256(digest key, value),
lowercase hex (32 chars). Deterministic across snapshots (required for
idempotent trees). Remove plaintext id echoes (`connection_id`, `owner_id`,
`blob_id`, `vault_id`, `item_id`) from snapshot JSON bodies; if any restore
path reads an id back from a body, move that id inside the ciphertext
payload — verify by reading the restore/consumer code first.

### 3.6 Audit metadata digests

In `packages/audit/src/redact.ts`, `keyNames` values no longer
pass verbatim: each value V becomes `hmac:<first 16 hex of digest>` using the
existing peppered `hmacDigest` pattern from
`packages/os-domain/src/crypto/claim-token.ts` with purpose string
`"audit-metadata"`. Same-value correlation across events is preserved;
recovery of low-entropy names by offline guessing is not possible without the
pepper. The producer side (`outbox_events.payload.store_path`, consumed at
`apps/worker/src/rotation.ts` ≈88) applies the same digest at emission.

### 3.7 Breach-check module

`apps/pages/src/lib/vault/breach.ts` exporting:
`sha1HexUpper(text: string): Promise<string>` (WebCrypto),
`splitHash(h: string): { prefix5: string; suffix35: string }`,
`matchSuffix(rangeBody: string, suffix35: string): number` (pure; parses
`SUFFIX:COUNT` lines; `Add-Padding` responses include count-0 padding lines —
breached means count ≥ 1),
`checkPasswords(passwords: ReadonlyMap<string /*itemId*/, string>, opts):
Promise<ReadonlySet<string /*breached item ids*/>>` — dedupes identical
passwords before querying, concurrency ≤ 4, calls
`GET https://api.pwnedpasswords.com/range/{prefix5}` with request header
`Add-Padding: true`, and a `fetch` seam injectable for tests (follow the
`totpSeams` seam-object style). Results cache
`{ prefix: string; checkedAtIso: string; count: number }` persists ONLY
inside the sealed vault body settings — never plaintext localStorage.
`health.ts` gains `"breached"` in `HealthIssue` and
`buildHealthReport(items, breached?: ReadonlySet<string>)` — stays pure;
fetching never happens inside health.ts.

### 3.8 Copy contracts (exact strings)

- UnlockScreen creation checkbox (replaces "I understand this vault cannot
  be recovered."): **"I understand that without my unlock methods and
  Recovery Kit, this vault cannot be recovered — by anyone."** (True with or
  without a kit.)
- No-Recovery Rule amendment (DESIGN.md L131 area): the rule is renamed in
  spirit, not deleted — *"There is no recovery we can perform. If you create
  a Recovery Kit, it — and only it — can recover this vault; we cannot.
  Without one, loss of all unlock methods is permanent."*
- HealthPanel default copy stays truthful: the passive report contacts
  nothing. The opt-in breach-check button carries: **"Checks passwords
  against Have I Been Pwned using k-anonymity: only the first 5 characters
  of a SHA-1 hash leave this device — never a password or full hash."**
  The check NEVER auto-runs.
- DESIGN.md's Honest Crypto example (≈L127–129 claims the report "contacts no
  breach service") is amended to describe the opt-in reality, and stale L209
  ("no PIN… no recovery") is corrected to name the real unlock surface.

## 4. Subagent swarms

Spawn each task below as its own subagent. Tasks within and across swarms
run in PARALLEL except the single integration agent (V1), which runs last.
Each task lists OWNED files (only it may touch them) and acceptance criteria.
No task may modify a file another task owns — the ownership matrix in §5 is
the conflict authority. Every task runs its own scoped tests before
finishing; V1 runs the global gates.

### Swarm R — Account recovery

**R1 — ADR-RECOVERY + design docs.**
Owns: `docs/adr/<next>-account-recovery.md` (new), `DESIGN.md`,
`docs/security/key-hierarchy.md`.
Write ADR-RECOVERY with a full options matrix — each option evaluated for
pros/cons against the No-Recovery Rule, the ZK invariant, and the LastPass
failure mode:
(a) printable recovery key/emergency kit (random 256-bit wrapping VK;
Bitwarden/1Password precedent) — ACCEPT as baseline: ZK-preserving, offline,
maps onto the existing multi-wrap seam, already sanctioned by
key-hierarchy.md; cons: paper is stealable/losable, demands user discipline.
(b) Shamir k-of-n across devices/contacts — DEFER: no share-distribution
channel exists, heavy UX, dual-language SSS is new crypto surface; future
work anchored on `packages/ceremony-kit`/ADR 0044/0045.
(c) social/trusted-contact ceremony — DEFER: needs contact identity, delay
windows, an encrypted share channel; coercion risk; recovery-graph already
models `trusted_contact` for the eventual UX.
(d) server-side escrow — REJECT and record why: it is precisely the LastPass
architecture; the server structurally refuses to wrap client blobs today and
must continue to.
(e) second passkey/PRF wrap as recovery — ACCEPT as encouraged complement
(hardware-bound, phishing-proof, code exists; doesn't survive
lost-everything).
(f) time-delayed recovery — REJECT for baseline (needs an authoritative
clock/notifier; reintroduces (d)-shaped trust); note as optional layer on (c).
(g) do nothing (status quo) — REJECT as sole stance but preserve as default:
the kit is opt-in, never mandatory.
Record the KDF stance: Pages stays PBKDF2-600k (no WebCrypto Argon2; wasm
supply-chain/bundle cost; band enforcement already prevents iteration rot;
Rust plane already Argon2id) and the recovery path is KDF-independent
(256-bit uniform key → HKDF, no stretching). Record the §3.1 wire format.
Amend DESIGN.md and key-hierarchy.md per §3.8 (all DESIGN.md edits in this
program belong to R1, including the breach-copy example amendment).
Acceptance: ADR follows the house format of `docs/adr/0017-*.md`; every
option has explicit pros, cons, verdict; `pnpm lint` clean.

**R2 — TS recovery crypto core.**
Owns: `apps/pages/src/lib/vault/recovery-key.ts` (new),
`apps/pages/src/lib/vault/recovery-key.test.ts` (new),
`apps/pages/src/lib/vault/unlock-methods.ts`,
`apps/pages/src/lib/vault/store.ts`.
Implement §3.1 exactly: `generateRecoveryKey()` (returns `{ display: string;
bytes: Uint8Array }`), `parseRecoveryKey(display)` (typed errors:
format/version/checksum), `wrapVaultKeyWithRecoveryKey(bytes, rawVk)`,
`unwrapVaultKeyWithRecoveryKey(bytes, record)`, `computeVerifier`,
`matchesVerifier`. Reuse the HKDF + AES-GCM helpers already used by
`kekFromWebauthnPrf`/PIN wraps (export them from `unlock-methods.ts` if
private). Add `recovery?: RecoveryUnlockRecord` to `VaultUnlocks` and a
`hasRecoveryKit(header)` helper; confirm `assertKeepsPrimaryUnlock` ignores
it (add a regression test). In `store.ts`, add `addRecoveryWrap(displayKey)`,
`removeRecoveryWrap()`, `unlockWithRecoveryKey(displayKey)` following the
existing PIN-wrap persistence path (find the PIN methods and mirror them,
including host-backup re-push on header change).
Tests: round-trip; wrong key fails with verifier mismatch before AES-GCM
failure; checksum catches any single-character typo (property test over
positions); Crockford normalization (O→0, I/L→1, lowercase); serialized
header never contains the display key or raw bytes (plant-and-assert-absent);
primary-unlock invariant untouched.
Verify: `pnpm --filter @opensesame/pages test`, `pnpm lint`.

**R3 — Recovery UI.**
Owns: `apps/pages/src/sections/settings/RecoveryPanel.tsx` (new),
`apps/pages/src/sections/settings/RecoveryGraphCard.tsx` (new),
`apps/pages/src/screens/UnlockScreen.tsx`, `apps/pages/package.json`.
RecoveryPanel: generate kit → display once with explicit "this will not be
shown again" → require the user to re-enter the key before the wrap persists
→ offer Emergency Kit download (self-contained printable HTML via
`URL.createObjectURL`, same pattern as the export flows in
`sections/SettingsSection.tsx` ≈287; content: the OSRK key, a QR of it via
`encodeQrSvg` from `packages/qr`, vault creation date, instructions, and a
warning to store offline) → revoke/rotate actions. Call only R2's API per
§3.1. RecoveryGraphCard: add `@opensesame/recovery-graph` to
`apps/pages/package.json` (workspace protocol, first consumer); build the
graph from the current `VaultHeader` unlocks (nodes: vault; password; pin;
passkey; recovery_code; edges `recovers`/`authenticates`) and render
`findArticulationPoints`/`calculateIndependentRoots` results as plain-language
warnings ("Your master password is currently a single point of failure").
UnlockScreen: when `unlocks.recovery` exists, show a "Lost access? Use your
Recovery Kit" path; on successful recovery unlock, force a re-wrap ceremony —
require setting a NEW master password immediately (a used recovery key has
been exposed to a keyboard) and generate a fresh kit (old record replaced);
do not require a passkey. Update the creation checkbox copy per §3.8.
Do NOT mount the panels into SettingsSection — V1 wires mounting.
Tests: component tests alongside the existing unlock/settings test files;
assert the checkbox copy string; assert the recovery path hidden when no
record exists.
Verify: `pnpm --filter @opensesame/pages test`, `pnpm lint`.

**R4 — Rust human-vault parity.**
Owns: `crates/human-vault/src/lib.rs` (and its test module).
Add `RecoveryWrapper`, `wrap_vrk_with_recovery_key`,
`unwrap_vrk_with_recovery_key`, plus OSRK encode/parse helpers
(`encode_recovery_key`, `parse_recovery_key`) per §3.1 (HKDF info
`"opensesame/vault/recovery-key/v1"`, XChaCha20-Poly1305 like
`PasswordWrapper`, Zeroize on key material). Tests mirror the
`wrap_vrk_with_password` block: round-trip, wrong key, tampered wrapper,
checksum/typo rejection, and a cross-language vector test: hard-code one
known key/salt → assert the derived KEK bytes equal the value produced by
the TS implementation (compute the vector once from the spec, embed hex in
both R2's and R4's tests — the spec in §3.1 is deterministic, so both sides
derive the same constant independently).
Verify: `cargo +1.88.0 test -p opensesame-human-vault`,
`pnpm audit:clippy`.

### Swarm T — TOTP import/export

**T1 — Google Authenticator migration codec.**
Owns: `apps/pages/src/lib/vault/import/otpauth-migration.ts` (new) + its
test file (new).
Implement §3.2 exactly (hand-rolled varint/wire-format, zero deps; ~120
lines). Tests: golden vectors (build a known payload from known secrets,
assert exact base64; decode a hand-assembled fixture); encode→decode
round-trip property; malformed inputs (truncated varint, wrong wire type,
oversized field, bad base64, URL-encoded data param) return typed errors —
never throw uncontrolled; HOTP entries surface with `type: "hotp"`.
Verify: `pnpm --filter @opensesame/pages test`.

**T2 — TOTP export surface.**
Owns: `apps/pages/src/lib/vault/export/totp.ts` (new) + test (new),
`apps/pages/src/sections/settings/TotpExportPanel.tsx` (new),
`apps/pages/src/sections/vault/ItemDetail.tsx`.
`export/totp.ts` (pure): `buildOtpauthUri(item: LoginItem): string | null`
— canonical `otpauth://totp/<Issuer>:<account>?secret=<BASE32>&issuer=…
&digits=…&period=…&algorithm=…` from `item.totp` (reuse `parseTotp` from
`../totp.ts`; if the stored value is already a URI, re-canonicalize; issuer
from item name, account from the login username field; URL-encode labels);
`totpExportEntries(items)` — non-deleted logins with `totp !== ""`;
`buildMigrationUris(entries)` — delegate to T1's `encodeMigrationUris`
(import the frozen interface; both sides compile against §3.2 so parallel
work is safe). TotpExportPanel: "Export authenticator secrets" — (1)
downloadable plaintext otpauth-URI list (one per line) behind an explicit
click with a stern warning matching the tone of the existing manifest export
("contains secrets in plaintext; never commit or upload"); (2) on-screen
paged Google-Authenticator migration QRs rendered with `encodeQrSvg`
(nothing written to disk on the QR path). ItemDetail: route the existing
per-item QR (≈507–550) through `buildOtpauthUri` so item QR and bulk export
emit identical URIs. Do NOT mount the panel — V1 wires mounting.
Tests: golden URI vectors (known secret → exact URI), unicode issuer
escaping, base32 normalization, migration round-trip through T1's decoder.
Verify: `pnpm --filter @opensesame/pages test`.

**T3 — Authenticator-app import adapters.**
Owns: `apps/pages/src/lib/vault/import/formats/authenticators.ts` (new) +
test (new), `apps/pages/src/lib/vault/import/types.ts`,
`apps/pages/src/lib/vault/import/index.ts`.
Three adapters on the existing `ImportAdapter` interface (mirror
`formats/protonpass.ts` structure): `otpauth-uris` (plain text, one
`otpauth://` or `otpauth-migration://` URI per line; migration URIs decode
via T1; produces `DraftLogin`s with `totp` set through `normaliseTotp`);
`aegis-json` (unencrypted Aegis export: `db.entries[].{type,name,issuer,
info:{secret,algo,digits,period}}`; encrypted Aegis files — detectable by
`header.slots` — are recognized by `detect` and return a warning entry
"export unencrypted from Aegis first"; scrypt is unavailable in WebCrypto,
decryption is out of scope); `twofas-backup` (unencrypted `.2fas`:
`services[].{name,secret,otp:{issuer,digits,period,algorithm,tokenType}}`;
encrypted `servicesEncrypted` → same warning pattern). HOTP entries are
skipped with per-entry warnings. Extend the `SourceId` union; register in
`ADAPTERS` (order: `otpauth-uris` after `envFile`; the two JSON adapters
before generic CSV). Tests mirror the existing per-format test files, plus a
GA-migration fixture generated from known secrets (round-trip with T1).
Verify: `pnpm --filter @opensesame/pages test`.

**T4 — QR image decode for import.**
Owns: `apps/pages/src/lib/vault/import/qr-image.ts` (new) + test (new),
`apps/pages/src/sections/settings/ImportPanel.tsx`, root `pnpm-lock.yaml`
delta for the dependency, `apps/pages/package.json` — coordinate: R3 also
edits `apps/pages/package.json`; to avoid conflict, T4 adds `jsqr` while R3
adds `@opensesame/recovery-graph`; both are single-line additions in the
dependencies block — V1 resolves the trivial merge if both land.
`qr-image.ts`: decode an uploaded image (File/Blob → ImageBitmap/canvas →
`jsQR(imageData)`) returning the decoded text or a typed failure; `jsQR` is
pure-JS, zero-dependency (the ONLY new npm dependency in this program — run
`pnpm audit:osv` and `pnpm audit:cve-lite` after adding; if either gate
fails, vendor the single-file implementation under
`apps/pages/src/lib/vendor/jsqr/` with license header instead). ImportPanel:
accept `image/*` files; route decoded text into the normal adapter detection
chain (a GA screenshot yields an `otpauth-migration://` URI → T3's adapter).
Live camera scanning (getUserMedia) is OUT OF SCOPE.
Tests: fixture PNG of a known QR (generate at test time via `packages/qr`
SVG → rasterize, or embed a small base64 PNG fixture); non-QR image returns
the typed failure.
Verify: `pnpm --filter @opensesame/pages test`, `pnpm audit:osv`,
`pnpm audit:cve-lite`.

**T5 — control-plane TOTP base32 bug fix.**
Owns: `apps/control-plane/src/routes/mfa.ts` + its test file.
At ≈line 362 the enroll response builds
`otpauth://totp/...?secret=<hex>` — hex is wrong; RFC-compatible
authenticator apps require Base32. Add a local ~15-line RFC 4648 Base32
encoder in the route module (control-plane must not import Pages code) and
emit the base32 secret in the URI (keep any existing base64/hex fields in
the JSON body unchanged for compatibility; only the URI changes). Unit test:
decode the base32 back to the stored secret bytes; assert the URI matches
`/secret=[A-Z2-7]+/`. This endpoint is dev-only (`totp_dev_only` gate), so
this is a correctness fix — no audit doc; explain in the commit message.
Verify: `pnpm --filter @opensesame/control-plane test`, `pnpm lint`.

### Swarm M — Metadata hardening

**M1 — sealed-store: name-free commits + blinded v2 layout + migration.**
Owns: `crates/sealed-store/src/{store.rs, path.rs, envelope.rs, manifest.rs}`,
`crates/sealed-store/src/blind.rs` (new), `apps/cli/src/main.rs`,
`apps/cli/src/store.rs` (the `pass migrate` verb addition only — this agent
is the sole owner of both CLI files in this program).
Two changes, one owner (same files):
(1) Commit messages per §3.4 — replace every name-bearing `format!` at
`store.rs` ≈156, ≈170/174, ≈253, ≈293, ≈304 and `manifest.rs` ≈72.
(2) Blinded v2 layout per §3.3 — `blind.rs` implements `path_key` derivation,
`blinded_relpath(logical) -> String`, and the sealed index entry
(read/update/rewrite in the same commit as mutations); `path.rs` gains
v2-aware resolution (v1 fallback preserved); `envelope.rs` `store_ad()` uses
the blinded id as `item_id` for v2 entries (index entry AD `item_id:
"__index__"`); listing/prefix ops (`store.rs` ≈347) consult the index when
v2; `opensesame pass migrate --blind` converts v1→v2 in one commit
(idempotent — running twice is a no-op); `pass init` defaults to v2;
gpg/age passthrough entries excluded and documented in the ADR (M2 writes
docs; M1 writes code — both derive from §3.3, so no coordination needed).
Tests (the regression fences): plant a distinctive name
(`XZQPLANTED/secret-name`), run insert/edit/rebind/remove/manifest-seal, then
assert the name absent from (a) every commit message in `git log`, (b) every
on-disk relative path, and (c) the raw bytes of every file in the store
(this catches cleartext AD); v2 round-trip (insert → show → ls → find →
remove); v1 store still fully functional; v1→v2 migration idempotence and
`ls` equivalence pre/post; deterministic blinded paths (same name → same
path).
Verify: `cargo +1.88.0 test -p opensesame-sealed-store`,
`cargo +1.88.0 test -p opensesame-cli` (or the workspace test if the CLI has
no own suite), `pnpm audit:clippy`.

**M2 — Metadata docs: ADR-BLINDED-STORE + dated audit doc.**
Owns: `docs/adr/<next+1>-blinded-sealed-store-layout.md` (new),
`docs/security/audit-2026-08-22-sealed-store-metadata.md` (new).
ADR-BLINDED-STORE records §3.3/§3.4 (motivation: the LastPass plaintext-metadata
lesson; the decision; the v1 compatibility story; the gpg/age limitation;
alternatives considered: per-entry random ids + mandatory index — rejected
for losing deterministic idempotent writes; encrypting only filenames —
rejected because cleartext `AssociatedData.item_id` inside `.osseal` files
would still leak names). The audit doc follows the house style of the
existing `docs/security/audit-2026-08-08-*.md` files: what leaked (commit
messages, paths, envelope AD; concrete examples), impact (backup-repo
readers learn every folder/item name + change cadence), the fix, and the
operator note that EXISTING repos retain leaked names in history — scrubbing
requires history rewrite + force-push, documented as a manual procedure
(exact `git filter-repo` command sketch), never automated.
Verify: `pnpm lint`.

**M3 — Gateway backup tree blinding.**
Owns: `apps/gateway/src/backup.rs` (and its tests).
Implement §3.5: replace the reversible
`URL_SAFE_NO_PAD.encode` `path_component` (≈line 252) with the keyed-digest
scheme; strip plaintext id echoes from `SnapshotFile` JSON bodies (first
read the snapshot consumer/restore path to confirm nothing parses ids back
out of bodies; if something does, seal the ids inside the ciphertext payload
it already carries). Keep tree determinism (same ids → same paths across
snapshots) so idempotent commits and deletion propagation still hold.
Tests: plant distinctive ids (`XZQCONN`, `XZQITEM`) and assert absent from
every `SnapshotFile.path` and every body byte; determinism (two snapshots →
identical paths); existing backup actor tests stay green.
Verify: `cargo +1.88.0 test -p opensesame-gateway`, `pnpm audit:semgrep`.

**M4 — Audit/outbox metadata digests.**
Owns: `packages/audit/src/redact.ts` + tests, `packages/audit/src/changelog.ts`
(if `keyNames` flows through it), `apps/worker/src/rotation.ts` + tests, and
the producer that writes `store_path` into `outbox_events.payload` (locate
with `rg "store_path" --type ts` and take ownership of the writer call
sites; if a producer file is owned by another task — none are expected —
report to V1 instead of editing).
Implement §3.6. Preserve event-correlation semantics: the digest is
deterministic per pepper, so "same secret, later event" still correlates.
Tests: `keyNames` inputs no longer appear verbatim in redacted
output; digests are stable within a pepper and change across peppers; the
worker's rotation view carries digests only (plant `XZQPATH/name`, assert
absent from the view and from log lines).
Verify: `pnpm --filter @opensesame/audit test`,
`pnpm --filter @opensesame/worker test`, `pnpm lint`.

**M5 — Remove the plaintext sync-id footgun.**
Owns: `apps/pages/src/lib/vault/store-sync.ts`,
`apps/pages/src/lib/vault/store-sync.test.ts`.
Delete `storePathToSyncBlobId` (≈line 323) — it renders logical store paths
(`project:{id}:Email/github.com`) as "opaque" sync-blob ids and is referenced
only by its test (≈line 96). Remove the function and its test; leave a
one-line comment at the former site is NOT needed (dead code goes without a
tombstone). Confirm via `rg storePathToSyncBlobId` that no other references
exist; if any appear, replace them with a keyed-digest id and report the
deviation to V1.
Verify: `pnpm --filter @opensesame/pages test`.

### Swarm B — Breach monitoring

**B1 — HIBP k-anonymity breach checks (client-side, opt-in).**
Owns: `apps/pages/src/lib/vault/breach.ts` (new) + test (new),
`apps/pages/src/lib/vault/health.ts` + its tests,
`apps/pages/src/sections/vault/HealthPanel.tsx`.
Implement §3.7 and §3.8. HealthPanel: keep the passive report fully local
(its existing copy stays true); add the opt-in "Check for breached
passwords" button with the exact §3.8 copy; show per-item `breached` issues
after a run; gate the button on connectivity via the
`connectivity-monitor.ts` supervisor (disabled + explanatory state offline);
never auto-run, and no background scheduling in this program (re-check is
manual). Persist the result cache in the sealed body settings so re-opening
the vault retains findings. Do NOT touch DESIGN.md (R1 owns it). Do NOT
change CSP: `apps/pages/index.html` already allows `https:` in
`connect-src`; verify the service worker (if any fetch handler intercepts)
passes `api.pwnedpasswords.com` through, and only change the service worker
if verification shows interception.
Tests (load-bearing): with a mocked fetch seam, run a full check and assert
EVERY requested URL matches `^https://api\.pwnedpasswords\.com/range/[0-9A-F]{5}$`
with no request body and the `Add-Padding` header set — the only
network-visible artifact is the 5-char prefix; `matchSuffix` fixture tests
incl. count-0 padding lines (not breached) and real-count lines (breached);
dedupe (N items, same password → 1 request); `buildHealthReport` purity
(breached set injected, no fetch inside).
Verify: `pnpm --filter @opensesame/pages test`, `pnpm lint`.

**B2 — ADR-BREACH: server-side email breach monitoring (design only).**
Owns: `docs/adr/<next+2>-breach-monitoring.md` (new).
Design, do not build — and record WHY nothing is built now: the repo has no
email/push delivery channel (`pushNotifications: false` in control-plane
discovery; no mail sender anywhere) and the worker makes no outbound HTTP;
alerts without a channel are theater, and server-side breach state requires
blinded item/identity handles (the M-swarm work) to avoid becoming the next
metadata leak. Contents: consent-per-address opt-in model (emails are PII
sent to a third party — HIBP breached-account API requires an API key and
receives the subscriber's address; per-address consent, revocable);
API-key custody via the `.env.schema` env-spec pattern (`@sensitive`);
worker architecture reusing the existing interval loop
(`apps/worker/src/cleanup.ts` `startCleanupLoop`) and outbox→NATS event
emission with a new `credential.breach.detected` event type beside the
rotation events (the unwired `consumeRotationEvents` in
`apps/worker/src/rotation.ts` is the consumer skeleton; breach→rotation is
the natural chain); storage = breach name + peppered address digest only
(reuse `hmacDigest`), never plaintext addresses in breach tables; alert
ladder — in-app first (`NotificationsBar.tsx` bell, ceremonies Inbox per
ADR 0046), email later when a sender exists; HIBP rate limits and the
subscription tiers; explicitly contrast with B1's password path (k-anonymity
needs no key, no consent beyond the click, and no server).
Verify: `pnpm lint`.

### V1 — Integration, global validation, delivery (runs LAST, alone)

Owns: `apps/pages/src/sections/SettingsSection.tsx`, any cross-task merge
resolution (`apps/pages/package.json`, `pnpm-lock.yaml`), the untracked
drizzle file decision (§1), and the final git/PR workflow.
1. Mount `RecoveryPanel`, `RecoveryGraphCard`, and `TotpExportPanel` into the
   settings surface (`SettingsSection.tsx` — follow how existing panels like
   `OfflineBackupPanel`/`GithubBackupPanel` are mounted and ordered; recovery
   panels near the unlock-methods panel, TOTP export near the existing
   export flows).
2. Resolve the `apps/pages/package.json` two-dependency merge (R3 + T4) and
   refresh the lockfile (`pnpm install --lockfile-only` or full install).
3. Handle `packages/database/drizzle/0005_steep_mephisto.sql` per §1.
4. Run the full gate ladder and fix all fallout, re-running until green:
   `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm verify`, then
   `pnpm audit:ast-grep && pnpm audit:semgrep && pnpm audit:clippy &&
   pnpm audit:osv && pnpm audit:cve-lite`.
5. End-to-end manual validation via `pnpm --filter @opensesame/pages dev`
   (vite :5180): create vault → generate Recovery Kit → lock → recover via
   kit → confirm forced master-password re-wrap + kit rotation; export a GA
   migration QR → import its screenshot → identical items round-trip; run
   the opt-in breach check with network dev-tools open → confirm only
   5-hex-char range requests; confirm offline state disables the button.
6. Commit in coherent, reviewable units (one commit per swarm-area is
   acceptable; name-free where the diff itself is a metadata fix —
   commit messages must not embed example secret names beyond the planted
   test constants in code). Push `git push -u origin
   claude/2fa-account-recovery-security-oz3r2b` (retry ×4 with 2/4/8/16s
   backoff on network failure only). Open ONE pull request (ready, not
   draft) if no open PR exists for the branch; PR body summarizes all five
   priority areas, lists the three new ADRs and the audit doc, states test
   coverage, and ends with the attribution footer (§1).

## 5. File-ownership matrix (conflict authority)

| File(s) | Owner |
|---|---|
| `docs/adr/*-account-recovery.md`, `DESIGN.md`, `docs/security/key-hierarchy.md` | R1 |
| `apps/pages/src/lib/vault/recovery-key.ts[.test]`, `unlock-methods.ts`, `store.ts` | R2 |
| `RecoveryPanel.tsx`, `RecoveryGraphCard.tsx`, `UnlockScreen.tsx` | R3 |
| `crates/human-vault/**` | R4 |
| `import/otpauth-migration.ts[.test]` | T1 |
| `export/totp.ts[.test]`, `TotpExportPanel.tsx`, `ItemDetail.tsx` | T2 |
| `import/formats/authenticators.ts[.test]`, `import/types.ts`, `import/index.ts` | T3 |
| `import/qr-image.ts[.test]`, `ImportPanel.tsx` | T4 |
| `apps/control-plane/src/routes/mfa.ts` (+tests) | T5 |
| `crates/sealed-store/**`, `apps/cli/**` | M1 |
| `docs/adr/*-blinded-sealed-store-layout.md`, `docs/security/audit-2026-08-22-sealed-store-metadata.md` | M2 |
| `apps/gateway/src/backup.rs` | M3 |
| `packages/audit/**`, `apps/worker/src/rotation.ts`, `store_path` producers | M4 |
| `apps/pages/src/lib/vault/store-sync.ts[.test]` | M5 |
| `breach.ts[.test]`, `health.ts` (+tests), `HealthPanel.tsx` | B1 |
| `docs/adr/*-breach-monitoring.md` | B2 |
| `SettingsSection.tsx`, `apps/pages/package.json` (merge), lockfile, git/PR | V1 |

`apps/pages/package.json`: R3 and T4 each add exactly one dependency line;
V1 arbitrates. No other file has two owners. A task needing a change in a
file it does not own reports the need to V1 instead of editing.

## 6. Adversarial pitfalls (each has bitten a prior draft — do not repeat)

1. Do NOT add a CSP entry for pwnedpasswords — `connect-src` already allows
   `https:`. Verify service-worker interception instead.
2. Do NOT add a `pass otp uri` CLI verb — it exists (`cmd_otp_uri`,
   `apps/cli/src/store.rs` ≈466).
3. Blinding filenames without blinding `AssociatedData.item_id` is
   pointless — the name is cleartext INSIDE every `.osseal`. The plant-name
   test must scan file BYTES, not just paths.
4. The recovery wrap must NOT satisfy `assertKeepsPrimaryUnlock` or appear
   in `UnlockMethodId` — paper is not a daily unlock.
5. HIBP `Add-Padding` responses contain count-0 padding lines — count ≥ 1
   means breached; count 0 does not.
6. GA migration `data=` base64 arrives URL-mangled (`+`→space, `%2B`, `%3D`)
   — normalize before decoding; secrets in the protobuf are RAW BYTES, not
   base32 text.
7. control-plane cannot import Pages modules — the base32 encoder in T5 is
   local to the route.
8. `os-domain` import bans (§1) — none of the new TS touches os-domain, keep
   it that way.
9. Gateway digest keys derive from the deployment seal via HKDF with the §3.5
   info string — hashing ids is permitted; WRAPPING client blobs with the
   deployment seal is structurally refused and must remain so.
10. Existing sealed-store repos retain leaked names in git history — the fix
    stops the bleeding; history scrubbing is a documented manual operator
    procedure (M2), never automated code.
11. The Pages vault and the Rust vault are different crypto stacks by
    design (PBKDF2/AES-GCM vs Argon2id/XChaCha20). Recovery "parity" means
    identical OSRK format + KDF derivation, not identical envelopes.
12. Every UI-visible behavior change lands with its copy change in the same
    commit (Honest Crypto Rule) — the breach button, the recovery checkbox,
    and DESIGN.md must never disagree with the code.
13. Commit messages, PR text, and code comments carry no model identifiers.

## 7. Definition of done

- All three ADRs (recovery, blinded store, breach monitoring — numbered at
  implementation time, never copied from this document) and the dated audit
  doc exist and read
  as decisions, not summaries.
- Recovery Kit works end-to-end in Pages (create→confirm→download→revoke→
  recover→forced re-wrap) with Rust primitives in parity; recovery-graph
  renders SPOF analysis in Settings.
- TOTP: GA migration QRs export and re-import losslessly; Aegis/2FAS/URI-list
  imports work; QR screenshots decode; per-item and bulk URIs are canonical;
  the control-plane enroll URI is base32.
- Metadata: plant-name/plant-id tests prove names and ids absent from
  sealed-store commit messages, on-disk paths, `.osseal` file bytes, gateway
  snapshot trees/bodies, audit rows, and worker views; v1 stores still work;
  `pass migrate --blind` converts idempotently.
- Breach: opt-in check flags breached items; the mocked-network test proves
  only 5-hex-char prefixes leave the device; copy is honest everywhere.
- `pnpm verify` and the listed `audit:*` gates are green; the branch is
  pushed; one ready PR exists with the attribution footer.
