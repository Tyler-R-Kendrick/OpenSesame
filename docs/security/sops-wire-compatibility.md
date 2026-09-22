# SOPS wire compatibility

What `apps/pages/src/lib/sops` reproduces from upstream SOPS, why each
choice is upstream's rather than ours, and what it deliberately refuses.

**Target:** SOPS **v3.13.3**, source commit
`26e2f4784ca61353082c32dbd987c25eda086dc9`. That exact release is the
oracle for `pnpm verify:sops-conformance`; it is downloaded once, verified
against the checksums published with the release, and executed with an
empty environment, a private `HOME` and config directory, explicit identity
files, and no plugin or key-service discovery. The shipped browser never
invokes it. See [ADR 0130](../adr/0130-browser-local-sops.md).

## Scope

| Covered | Not covered |
| --- | --- |
| YAML and JSON documents | `dotenv`, `ini`, `binary` formats |
| Local `age` identities (X25519) | age plugins, age passphrase recipients |
| Key groups, Shamir thresholds | GPG/PGP, HashiCorp Vault, PKCS#11 |
| AWS KMS / Azure Key Vault / GCP KMS **wire contract** | Any claim those work against a given tenancy |
| `encrypted_suffix`, `unencrypted_suffix`, `encrypted_regex`, `unencrypted_regex`, `encrypted_comment_regex`, `unencrypted_comment_regex`, `mac_only_encrypted` | `--set` path syntax, key services, exec-env/exec-file, publish |

Anything outside the left column is an error that names the unsupported
feature. Nothing in this table is a security boundary on its own; it is a
statement of what has been tested against the oracle.

## The record format

```
ENC[AES256_GCM,data:<b64>,iv:<b64>,tag:<b64>,type:<str|int|float|bool|time>]
```

- **AES-256-GCM**, a fresh 32-byte nonce per record, a 16-byte tag. The
  nonce is 32 bytes because Go uses `cipher.NewGCMWithNonceSize`, so the
  browser uses `@noble/ciphers`, which accepts the same. Nothing truncates
  or rehashes a nonce to fit the 96-bit shape WebCrypto prefers — that
  would be a different ciphertext from a different document.
- **Standard base64** with padding — not URL-safe, and the engine rejects a
  non-canonical encoding rather than accepting a value it would re-emit
  differently.
- **Additional data is the path**: each component followed by `:`, joined,
  so `nested:deep:0:x:`. A record moved to another path fails to
  authenticate. This is what stops an attacker rearranging a document.
- **`type:`** is the *original* scalar kind, and it is how a decrypted
  document gets `1` back as an integer rather than the string `"1"`.
  `time` is an RFC 3339 timestamp.

## Scalars, or: Go is the specification

The MAC is computed over plaintext *bytes*, so a scalar that we render
differently from Go produces a different MAC and upstream rejects the
document. These are not stylistic choices.

| Kind | Upstream | Engine |
| --- | --- | --- |
| int | `strconv.Itoa` | `canonicalInt` — no `+`, no leading zeros, no separators |
| float | `strconv.FormatFloat(v, 'f', -1, 64)` | `goFloatText` — shortest round-tripping decimal, never exponent notation |
| bool | `True` / `False` | the same two words, capitalised |
| time | `time.Time.MarshalText` | RFC 3339, whole seconds |

Plain YAML scalars resolve the way `go.yaml.in/yaml/v3` resolves them,
which is not how JavaScript would: `017` is **15** (base 0), `0b101` is
**5**, `1_000` is **1000**, and a `uint64` beyond range is refused rather
than silently turned into a float. `yaml-resolve.ts` implements this and
`fixtures/tree/` holds 74 documents dumped by upstream's own loader to keep
it honest.

**Negative zero** is the one place the round trip is not a fixed point, and
it is upstream's: SOPS emits float `-0`, and its own loader reads that back
as **int** `0`. The engine emits `-0.0`, which upstream loads as float
`-0`. The fixture comparator normalises the sign of zero and says why in
place. Neither behaviour loses data; they simply disagree about the type of
a value nobody writes on purpose.

## Comments are tree items

Upstream does not attach a comment to a node — it puts comments *in* the
tree as their own items, in order. That is why
`encrypted_comment_regex` and `unencrypted_comment_regex` work the way they
do: a matching comment changes the treatment of the items that **follow**
it, tracked by a comments stack during the walk. `walk.ts` reproduces
`walkBranch`/`walkSlice` including that stack, and `yaml-comments.ts`
attaches comments by source offset so they survive a round trip in place.

## The MAC

- SHA-512 over every encrypted value's plaintext, in walk order, rendered
  as **uppercase hex**.
- Sealed as a record whose additional data is the document's
  `lastmodified`, so the timestamp cannot be edited without invalidating
  the MAC.
- `mac_only_encrypted` starts the digest from
  `SHA-256("sops")` (`MACOnlyEncryptedInitialization`) and feeds only the
  encrypted values.
- A MAC mismatch is a refusal to open. The engine never returns a document
  it could not authenticate, and `pnpm verify:sops-conformance` checks the
  reverse direction too: upstream rejects a browser-written file whose MAC
  we deliberately broke.

## Key groups and thresholds

- One group: an **OR** of its master keys — any one of them recovers the
  32-byte data key.
- Several groups: **Shamir over GF(2⁸)**, 33-byte `{y1..y32, x}` shares,
  one share per group, `shamir_threshold` groups required. Upstream's
  default threshold is *all* groups, and the engine defaults the same way.
- age entries are armored envelopes, one recipient per entry, wrapping
  either the raw data key (one group) or that group's share.
- A document whose threshold cannot be met does not open. It is never
  partially opened and never rewritten with a weaker policy — that is
  ADR 0129 §7's "preserved or refused, never silently flattened" as code.

## Selectors

At most one of `encrypted_suffix` / `unencrypted_suffix` /
`encrypted_regex` / `unencrypted_regex` may be set, which is upstream's own
rule; two is a configuration error, not a precedence puzzle.

The regexes are **Go/RE2**, not JavaScript. `re2.ts` is a Thompson NFA
simulation — linear time, no backtracking — with a 4,000-instruction
program cap and a 2,000,000-step execution cap, so a selector from an
imported `.sops.yaml` cannot be a denial-of-service. Lookaround and
backreferences are not in RE2 at all, so no SOPS config can depend on them.
Inline flags, named groups, Unicode and POSIX classes, `\Q…\E`, `\A`, `\z`,
`\C` and `\x{…}` *are* valid RE2 that this engine does not implement; a
config using one is reported as unsupported rather than reinterpreted.
Go's "invalid nested repetition" refusals (`a**`, `a*+`, `a{2}+`) are
reproduced, including the trailing `?` Go does allow.

## What the engine refuses

YAML aliases and anchors, merge keys (`<<`), non-string mapping keys,
duplicate keys, unknown tags, a document that is a sequence or a bare
scalar at the root, a `sops` key in a document being encrypted, a lone
surrogate in JSON, a JSON duplicate key, and any integer a `float64` would
round. Each is a named error. Refusing is the point: a format where the
reader and the writer disagree about what a document means is worse than
one that will not open it.

## Divergences, named

Three, and the first is the only one a reader is likely to hit:

- **Fail-closed YAML features.** Anchors, aliases, explicit tags and merge
  keys are refused at parse. Upstream `sops` handles them. The engine refuses
  because a lossless export outranks them, and silently flattening an alias or
  rewriting a tag is not lossless.
- **Recipient coverage.** Local age recovers a document here. A document whose
  only master keys are PGP, HashiCorp Vault or PKCS#11 recovers nothing, and
  the engine refuses it by name rather than pretending. AWS KMS, Azure Key
  Vault and GCP KMS adapters exist and implement upstream's encodings, but no
  live provider call has been proven from a browser.
- **Vault export is an OpenSesame convention, not a SOPS feature.** Exporting
  the vault writes an ordinary SOPS document; upstream edits it as one, and
  its own policy applies to its copy. Nothing about that round trip is part of
  the SOPS specification.

An earlier version of this document (2026-09-21, against the engine this one
replaced) also listed metadata byte layout as a divergence — `shamir_threshold`
presence and an extra `opensesame` field. Neither applies now: the engine emits
no `opensesame` field, and `shamir_threshold` only above one group, which is
upstream's own rule. The conformance gate compares against upstream output
directly, so a metadata drift would fail it.

## Bounds

`limits.ts`: 8 MiB input, 64 levels of nesting, 100,000 tree nodes, 32
documents in a stream, 32 key groups, 128 recipient entries. Past any of
them the engine reports the limit by name.

## How this is verified

| Gate | What it proves | Failure mode |
| --- | --- | --- |
| `pnpm verify:sops-conformance` | Both wire directions and both edit directions against the pinned, checksum-verified binary; 17 committed fixtures still match the digests it produced | **incomplete** (exit 2) when the oracle is absent — never a pass |
| `pnpm verify:sops-browser` | The whole workflow in a real browser on a static origin, online and offline, at a subpath and at a domain root; no request leaves the origin; the bundle names no native runtime | fail |
| `pnpm verify:sops-cloud-live` | Optional, opt-in, against disposable cloud resources | **blocked-external** when none is supplied |

Upstream can change its format. The pin makes that a visible failure rather
than a silent incompatibility — but a SOPS release newer than the pin is
untested here until the pin moves, and this document is only a claim about
v3.13.3.
