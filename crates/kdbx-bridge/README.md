# `opensesame-kdbx-bridge`

KDBX4 (KeePass) ⇄ sealed-store bridge. Reads a KeePass database into
`crates/sealed-store`, and writes the store back out as KDBX.

```rust
pub fn import_kdbx(
    bytes: &[u8],
    password: Option<&str>,
    keyfile: Option<&[u8]>,
    root: &StoreRoot,
    key: &ItemDataKey,
    opts: ImportOptions,
) -> Result<ImportSummary, KdbxError>;

pub fn export_kdbx(
    root: &StoreRoot,
    key: &ItemDataKey,
    prefix: Option<&str>,
    password: &str,
    opts: ExportOptions,
) -> Result<Vec<u8>, KdbxError>;

/// Read-and-map only: no store, no I/O beyond parsing the bytes.
pub fn map_kdbx(
    bytes: &[u8],
    password: Option<&str>,
    keyfile: Option<&[u8]>,
    prefix: Option<&str>,
) -> Result<(Vec<MappedItem>, Vec<ItemWarning>), KdbxError>;
```

Everything in [`map`](src/map.rs) is a pure function over plain data — no
`keepass` types, no file system, no crypto — so the contract below is
unit-testable, mutation-testable, and portable to the TypeScript adapter in
`apps/pages/src/lib/vault/import/formats/kdbx.ts`.

## Plane

Both directions yield plaintext to their caller, so both are **human-plane**
surfaces under constitution C2: drive them from the CLI behind the same
TTY/reveal ceremony as `opensesame pass show --reveal`, never from the agent
plane. Nothing in this crate logs, and no error message carries a field value
or a credential.

---

## The mapping contract (normative)

This is the statement of ADR 0052 §4.5. The Rust implementation here and the
TypeScript pages adapter must agree on every rule; `fixtures/kdbx/` is the
cross-implementation guard.

### Fields

| KDBX | Sealed store |
|------|--------------|
| `Password` | `Entry.secret` — line one |
| `Title` | the last segment of the store path (not a trailer line) |
| `UserName` | trailer `login: <value>` |
| `URL` | trailer `url: <value>` |
| `Notes` | trailer `notes: <value>`, multi-line preserved |
| `otp` (a full `otpauth://` URI) | `Entry.otp` |
| `TimeOtp-Secret-Base32` + `TimeOtp-Length` + `TimeOtp-Period` + `TimeOtp-Algorithm` | `Entry.otp`, synthesized |
| anything else | trailer `<sanitized-key>: <value>`, verbatim |

Details:

- **Empty values emit no trailer line at all.** A KDBX entry with an empty
  `UserName` produces no `login:` line.
- **Line endings** are normalized: `\r\n` and lone `\r` become `\n`.
- **A multi-line `Password`** keeps only its first line (line one of a store
  entry is single by construction) and raises
  `MapWarning::MultilinePasswordTruncated`. Real KDBX passwords are single-line.
- **Trailer order is deterministic**: `login`, `url`, `notes`, then every other
  field in ascending order of its *raw* KDBX field name, then the `otpauth://`
  line. `keepass` stores fields in a `HashMap`, so the sort is what makes the
  output stable.

### Trailer key sanitization

A KDBX field name becomes a trailer key by:

1. replacing `:` and every control character with `_`;
2. trimming leading and trailing whitespace;
3. mapping an empty result to `field`.

If the resulting key was already emitted (a custom field literally named
`login`, say), `_2`, `_3`, … is appended and `MapWarning::DuplicateKey` is
raised.

### Multi-line values

The first line of a value follows `key: `. Every subsequent line is written on
its own line prefixed with exactly **two spaces**. On the way back, a trailer
line starting with two spaces is a continuation of the previous pair, with
those two spaces removed.

```
notes: First line of the note.
  Second line.
  
  Fourth line, after a blank one.
```

The encoding is exactly reversible, including values whose own lines already
start with spaces (they simply gain two more).

Lines that are neither a `key: value` pair nor a continuation — only reachable
in a hand-written store entry — are appended to `Notes` on export rather than
dropped.

### TOTP

1. If `otp` is present and, after trimming, starts with `otpauth://` (any
   case), it is parsed by `sealed-store`'s `parse_otpauth`. On success it
   becomes `Entry.otp` and the `otp` field emits no trailer line.
2. Otherwise, if `TimeOtp-Secret-Base32` is present and non-empty, an
   `otpauth://` URI is synthesized:

   ```
   otpauth://totp/{percent-encoded Title}?secret={secret}&digits={d}&period={p}&algorithm={alg}
   ```

   with `d` from `TimeOtp-Length` (default `6`), `p` from `TimeOtp-Period`
   (default `30`), and `alg` from `TimeOtp-Algorithm` normalized by uppercasing
   and stripping `HMAC-` and `-` (so `HMAC-SHA-256` → `SHA256`; default
   `SHA1`). An empty title uses the label `entry`. Unparseable numbers fall
   back to the defaults. The four `TimeOtp-*` attributes are then consumed and
   emit no trailer lines.
3. If either path yields something `parse_otpauth` rejects — an unknown
   algorithm, a secret that is not base32 — **nothing is consumed**: the raw
   fields are preserved verbatim as ordinary trailer lines and
   `MapWarning::UnusableOtpField` / `UnusableTimeOtp` is raised. The bridge
   never guesses at a TOTP configuration.

### Path sanitization

The store path is the KDBX group path (the root group excluded) plus the entry
`Title`, joined with `/`. Each segment is sanitized:

1. `/`, `\`, and every control character become `_` — applied **before**
   trimming, so a leading tab becomes a leading `_`;
2. leading and trailing whitespace is trimmed;
3. an empty segment becomes `_`;
4. a segment consisting only of `.` characters has each `.` replaced by `_`
   (`.` → `_`, `..` → `__`), so `.` and `..` can never reach the store's path
   resolver.

| Raw | Sanitized |
|-----|-----------|
| `a/b` | `a_b` |
| `a\b` | `a_b` |
| `Tab\there` | `Tab_here` |
| `  padded  ` | `padded` |
| `` (empty) | `_` |
| `.` | `_` |
| `..` | `__` |
| `...` | `___` |

An `ImportOptions::prefix` is split on `/`, **empty segments dropped** (so
`a//b` is `a/b`, unlike a group literally named `""`), each remaining segment
sanitized by the same rules, and prepended.

### Collisions

Two KDBX entries can map to the same store path (same title in the same group,
or two titles that sanitize alike). The second gets ` (2)`, the third ` (3)`,
and so on appended to the whole path, with `MapWarning::PathCollision`.

Collisions are resolved **against the import batch only, never against what the
store already holds**. That is what makes re-importing the same file land on
the same paths and therefore be idempotent.

Comparison is exact and case-sensitive.

### Traversal order

Each group's own entries first, then its subgroups, both in KDBX document
order, depth first. Group nesting deeper than `map::MAX_GROUP_DEPTH` (64) is
skipped with `MapWarning::DepthLimited`, and the walk carries a visited set, so
a hostile file with a cyclic or thousands-deep group graph cannot loop or
overflow the stack.

### Export: protected fields

`Password` is written with `Protected="True"`, as is `otp` — a TOTP seed is
secret material even though the field name does not match the regex — and any
field whose name matches `(?i)pass|token|secret|key`. Everything else is
unprotected.

A trailer key that maps onto an already-written KDBX field name (`Title`,
`Password`, `otp`, …) is suffixed `_2`, `_3`, … the same way import keys are.

### Export: writer profile

Deliberately narrow, because the `keepass` crate's KDBX4 writer is
experimental:

| | |
|---|---|
| Version | **KDBX 4.1** |
| Outer cipher | AES-256-CBC (default) or ChaCha20 |
| Inner cipher | ChaCha20 |
| Compression | GZip |
| KDF | Argon2id, 64 MiB / 2 passes / 4 lanes by default |

> **KDBX 4.0 is not reachable.** ADR 0052 §4.5 asks for 4.0, but
> `keepass 0.13.22`'s `dump_kdbx4` rejects anything other than
> `DatabaseVersion::KDB4(1)` outright, so this crate emits 4.1. KeePass 2.x,
> KeePassXC and `kdbxweb` all read 4.1. See `EXPORT_KDBX_MINOR_VERSION`.

## Import merge semantics

Merges by store path:

| Store state at the path | `replace = false` | `replace = true` |
|---|---|---|
| absent | created | created |
| present, same content | unchanged (nothing written) | unchanged (nothing written) |
| present, different content | skipped (`SkipReason::Conflict`) | updated |

"Same content" is judged on the canonical view (`map::item_json`), not on
rendered text. `sealed_store::Entry`'s render/parse pair is not a fixed point —
the blank line separating the secret from the trailer moves in and out of
`trailer`, and for an empty secret a re-render promotes the first trailer line
into line one — so comparing raw text would report a spurious difference on
every second write generation and break idempotency.

Because unchanged entries are never rewritten, re-importing the same file
leaves the store, including its anti-rollback revisions, completely untouched.

## Tests

```bash
cargo +1.88.0 test -p opensesame-kdbx-bridge
cargo +1.88.0 clippy -p opensesame-kdbx-bridge --all-targets -- -D warnings
```

- `src/map.rs` — atomic unit tests for every mapping branch, both directions.
- `tests/roundtrip.rs` — export → import → store state equal, across the
  password-only / keyfile-only / password+keyfile matrix and both ciphers;
  merge semantics; idempotency.
- `tests/robustness.rs` — table-driven malformed input: truncation, bad magic,
  KDBX1/2 headers, flipped header bytes, corrupt HMAC blocks, wrong password.
- `tests/snapshots.rs` — `insta` characterization of the mapping, the trailer
  rendering, the exported field layout and the import summary. Review with
  `cargo insta review`; `.snap` files are committed.
- `tests/conformance.rs` — the committed `fixtures/kdbx/` pair. Regenerate
  with:

  ```bash
  cargo +1.88.0 test -p opensesame-kdbx-bridge --test conformance -- \
    --ignored regenerate_fixture
  ```

- `fuzz/fuzz_targets/kdbx_parse.rs` — `map_kdbx` over arbitrary bytes.
