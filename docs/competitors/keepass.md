# KeePass / KDBX — client-bridge target (format + local protocol)

> Competitive reference for OpenSesame's **KDBX file-format bridge** and the
> **keepassxc-protocol serving surface**
> ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md),
> [ADR 0053](../adr/0053-pm-bridge-binaries.md)). Never brand marks; never
> position OpenSesame as a KeePass replacement.

**Stance: study / client-bridge target.** KeePass is not a product we
compete with head-on — it is an *ecosystem* whose file format and desktop
protocol we implement from their public specifications so its clients keep
working. KeePass and KeePassXC source is **GPL and study-only**; nothing is
copied, ported, or transliterated.

## Overview

[KeePass](https://keepass.info/) (KeePass 2.x, Dominik Reichl) is the
original single-file offline password manager: one encrypted `.kdbx`
database on disk, no server, no account. Its longevity produced something
more valuable than the application — a **format with a documented,
stable, widely re-implemented on-disk representation**, and a family of
independent clients that all read it.

[KeePassXC](https://keepassxc.org/) is the actively developed
cross-platform reimplementation. It added the pieces the modern desktop
needs: a browser integration protocol, a Secret Service provider, an SSH
agent, and a share format.

| Dimension | KeePass / KDBX |
|-----------|----------------|
| Category | Offline single-file password manager |
| Trust model | Composite key (password / keyfile / Windows account) → KDF → database key; no server ever sees anything |
| On-disk root | A single `.kdbx` file the user places anywhere |
| Sync | **None built in.** The file is synced by whatever the user already uses (Dropbox/Syncthing/WebDAV/git) |
| Agent story | None — an unlocked database is plaintext to whoever opened it |
| License | KeePass 2.x GPL-2.0+; KeePassXC GPL-2.0/3.0 |

The absence of a sync server is the strategic point. Because the format is
the interface, KDBX interop buys compatibility with *every* client at once
rather than with one vendor's server.

## Feature surface

### KDBX 4 file internals (what a bridge must implement)

Verified against the public format documentation; this is the shape
`crates/kdbx-bridge` and the Pages adapter both implement.

1. **Signature.** Every KDBX file opens with the magic pair
   `0x9AA2D903` `0xB54BFB67`, followed by a version word. The second
   signature distinguishes KeePass 1.x from 2.x lineage; the version word
   distinguishes KDBX 3.1 / 4.0 / 4.1.
2. **Outer header — a TLV sequence** of `(id: u8, length: u32, data)`
   fields, read in the clear:
   - `CipherID` — a UUID naming the outer cipher (AES-256-CBC or
     ChaCha20; Twofish in some builds).
   - `CompressionFlags` — none or GZip for the inner payload.
   - `MasterSeed` — 32 bytes mixed with the transformed composite key.
   - `EncryptionIV` — the outer cipher's IV/nonce.
   - `KdfParameters` — **a VariantDictionary**, not a fixed struct: a
     typed key/value map (`$UUID` selecting AES-KDF or Argon2d/Argon2id,
     plus `S` salt, `M` memory, `I` iterations, `P` parallelism, `V`
     version). KDBX 4's single most important change is that KDF
     parameters became extensible data instead of header slots.
   - `PublicCustomData` — a second VariantDictionary for plugin data.
3. **Header integrity — two separate values.** KDBX 4 stores a
   **SHA-256 of the header bytes** (detects corruption) *and* an
   **HMAC-SHA256 over the header** keyed from the derived key (detects
   tampering). Both are checked before decryption begins. This is the
   fix for KDBX 3.1's unauthenticated header.
4. **Per-block HMAC'd payload stream.** The ciphertext is not one blob:
   it is a sequence of blocks, each carrying its own HMAC-SHA256 computed
   with a per-block-index key. A block failing its HMAC aborts the read.
   Authentication is therefore streaming and does not require buffering
   the whole database.
5. **Inner header** (KDBX 4 only, inside the decrypted+decompressed
   stream) — another TLV run carrying `InnerRandomStreamID` (ChaCha20 in
   KDBX 4; Salsa20 in 3.1), `InnerRandomStreamKey`, and one `Binary`
   entry per attachment. Attachments moved here from the XML in KDBX 4,
   so they are no longer base64 in the document.
6. **XML body with an inner keystream.** The database proper is an XML
   document of `Group` and `Entry` elements. Fields marked
   `Protected="True"` — passwords by default, and anything else the user
   protects — are **XOR'd with the inner ChaCha20 keystream and base64'd**.
   The keystream is consumed **in strict document order**: a reader that
   visits protected fields out of order, or skips one, decrypts every
   subsequent protected field to garbage. This ordering requirement is the
   single most common source of subtle KDBX reader bugs.

**KDBX 4.1** adds fields without changing the container: group and entry
tags, custom-icon names and modification times, an entry password-quality
check flag, and `PreviousParentGroup` (so a move can be undone). A 4.0
reader tolerates a 4.1 file's unknown elements; a 4.0 *writer* is the
conservative choice, which is what OpenSesame writes.

### Sync, such as it is

KeePass 2.x has **no sync server**, but it does have
`File > Synchronize > With File` and **`File > Synchronize > With URL`**,
which speaks HTTP/HTTPS, **WebDAV**, and FTP, and performs an entry-level
*merge* (using entry history and timestamps) rather than a
last-writer-wins overwrite. Mobile clients reach the same file over
WebDAV or a cloud provider's SDK. Any "serve KDBX over the network" idea
therefore has to implement merge semantics, not just GET and PUT — which
is why the WebDAV surface is a stretch/likely-cut row in ADR 0052 rather
than a tier-1 one.

### KeePassXC's additions

- **keepassxc-protocol** — the browser integration. The extension talks
  **stdio native messaging** to a `keepassxc-proxy` process, which relays
  to a **UDS socket** named `org.keepassxc.KeePassXC.BrowserServer` in
  `$XDG_RUNTIME_DIR`. Messages are JSON encrypted with **NaCl box**
  (X25519 + XSalsa20-Poly1305). The handshake is `change-public-keys` →
  `associate` (which stores a persistent identification key **after
  explicit user approval in the app**) → `test-associate`, followed by
  roughly fifteen encrypted actions: `get-databasehash`, `get-logins`,
  `set-login`, `get-totp`, `generate-password`, `lock-database`,
  `get-database-groups`, and the passkey actions.
- **Secret Service provider** — KeePassXC can expose the unlocked
  database as `org.freedesktop.secrets`, so `libsecret` consumers use it
  instead of gnome-keyring. It is a **singleton** D-Bus name.
- **SSH agent integration** — keys stored in the database offered to a
  running agent while unlocked.
- **KeeShare** — a signed `.kdbx.share` container for sharing a group
  between databases. The signature proves **origin, not freshness**: it
  says who produced the container, not that it is the newest one, so a
  stale share can be replayed. Treat it as a distribution format, not a
  sync protocol.

### The client ecosystem (the reason format compat pays)

| Client | Platform |
|---|---|
| KeePass 2.x | Windows (.NET), Mono elsewhere |
| KeePassXC | Linux / macOS / Windows |
| Keepass2Android | Android — including a keyboard-based autofill path |
| KeePassDX | Android — the modern KDBX 4 native client |
| Strongbox | iOS / macOS |
| KeeWeb, kdbxweb consumers | Browser / Electron |

None of these needs a server. All of them open a correct KDBX 4.x file, 4.1 included — which is what this repo's exporter emits.

## Differentiators (why operators still pick KeePass)

- **No account, no vendor, no network.** The threat model is a file on a
  disk. Nothing else in this space is that simple.
- **Format longevity.** A database from a decade ago still opens.
- **Full offline autonomy** with a client on every platform, most of them
  independent implementations.
- **Local-first browser integration** that never leaves the machine.

## Differentiators (why OpenSesame does not compete as a KeePass client)

- An unlocked KDBX is plaintext to whoever opened it. OpenSesame's
  agent plane never gets that — ConnectionRef → authorize → invoke →
  receipt ([ADR 0005](../adr/0005-authority-handle-connectionref.md)),
  and there is no `getSecret()`.
- OpenSesame is an authorization fabric with a sealed ceremony store, not
  a database-file editor with a GUI.
- The sealed store's unit is a path with a first-line secret and a
  key/value trailer, versioned in git with anti-rollback revisions — a
  different data model with a different audit story, not a KDBX clone.

## OpenSesame mapping

| KeePass / KDBX concept | OpenSesame |
|---|---|
| `.kdbx` file (KDBX 4.x) | `crates/kdbx-bridge` — read and write, from the public format spec |
| KDBX entry `Password` | Sealed-store `Entry.secret` (line 1) |
| KDBX `UserName` / `URL` / `Notes` | Trailer lines `login:` / `url:` / `notes:` |
| Other KDBX string fields | Trailer `<sanitized-key>: <value>`, preserved verbatim |
| KDBX TOTP (`otp`, `TimeOtp-*`) | `otpauth://` trailer via `crates/sealed-store/src/otp.rs` (pass-otp parity) |
| Group path + entry `Title` | Store logical path `Group/Sub/Title`, sanitized deterministically |
| `Protected="True"` | Applied on write to line 1 and to trailer keys matching `pass`/`token`/`secret`/`key` |
| Import a database | `opensesame pass import-kdbx` (merge-by-path, idempotent) |
| Export a database | `opensesame pass export-kdbx` — plaintext-equivalent output, so gated by the same TTY/`--reveal` ceremony as `pass show` |
| Open a `.kdbx` in the browser | Pages KDBX import adapter (kdbxweb + hash-wasm for Argon2, lazily imported) |
| KeePassXC CSV exports | Already handled — `keepassxcCsv` / `keepassCsv` adapters in the Pages import chain |
| keepassxc-protocol | `apps/pm-bridges` keepassxc bin: stdio native-messaging mode (recommended) or opt-in UDS mode, both default off |
| `associate` approval in the app | `opensesame bridge keepassxc pair` — a bounded window printing the incoming key fingerprint (ADR 0052 §2 ceremony) |
| `org.keepassxc.KeePassXC.BrowserServer` singleton | Conflict-detected: a live KeePassXC is named and the bridge refuses; only a verified-dead socket may be taken over |
| KeePassXC Secret Service provider | `apps/pm-bridges` secret-service bin (Linux, stretch, default off) — the same singleton policy applies against gnome-keyring/kwallet |
| KeeShare `.kdbx.share` | Not implemented — signature proves origin, not freshness; the sealed store's git history is the freshness story |
| `File > Synchronize > With URL` (WebDAV) | Stretch / likely cut — entry-level merge, not GET/PUT, is the real requirement |
| KeePassXC SSH agent | Not implemented |
| Catalog provider `keepass` | Existing `configuration` row (`database_path`, `password`, `key_file`); category `local_storage` |

## Deliberate non-goals vs KeePass

- Do not ship a KDBX GUI or position OpenSesame as a KeePass client.
- Do not copy KeePass or KeePassXC source. Both are GPL; the format and
  the protocol are implemented from their public documentation
  ([REUSE.md](../../REUSE.md), ADR 0052 §3).
- Do not make the sealed store a KDBX file. KDBX is an interop format at
  the edges; the store's own format, git history, and revision fences stay
  the system of record.
- Do not claim KDBX write parity beyond what is verified. The writer is
  constrained to KDBX 4.1 / AES-256 or ChaCha20 / Argon2id and is checked
  by a cross-implementation conformance fixture that an independent reader
  must open.

Related: [ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md),
[ADR 0053](../adr/0053-pm-bridge-binaries.md),
[`docs/architecture/pm-bridges.md`](../architecture/pm-bridges.md),
[`pass.md`](pass.md), [REUSE.md](../../REUSE.md).
