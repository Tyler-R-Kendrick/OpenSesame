# gitleaks gate — negative control

`pnpm audit:gitleaks` reports the working tree clean. Reviewed synthetic
fixtures have exemptions, so this confirms the scanner still works and
explains what those exemptions cost. Historical findings are reported
separately; working-tree cleanliness does not claim clean git history.

Run it after any change to `.gitleaks.toml`.

## Confirming the gate can still fail

The probe values are generated at run time rather than written out here. A
document containing two literal, correctly-shaped credentials is itself a
gitleaks finding — this file failed its own gate on the first attempt, which
is a tidy demonstration that the scanner works and a poor way to ship a
document.

```bash
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
cat > apps/pages/src/lib/leak-probe.ts <<EOF
export const gh = "ghp_$(rand 36)";
export const sk = "sk_$(printf 'live')_$(rand 24)";
EOF

pnpm audit:gitleaks     # expect: FAIL — github-pat and stripe-access-token
rm apps/pages/src/lib/leak-probe.ts
pnpm audit:gitleaks     # expect: CLEAN
```

The Stripe half of that probe matters most. `packages/env-spec-bridge/test/parse.test.mjs`
carries an inline exemption for a `stripe-access-token` finding, and the probe
proves that exemption did not disable the rule anywhere else.

Do **not** probe with `AKIAIOSFODNN7EXAMPLE`. That is AWS's published
documentation key and gitleaks allowlists it by default, so it comes back
clean and reads as a broken gate when nothing is wrong.

## How the exemptions are written

Three mechanisms, and the choice between them is not stylistic.

**Preferred — a trailing `// gitleaks:allow` on the offending line.** Only that
line is exempt; the rest of the file stays scanned.

The comment must be **trailing, on the same line**. On the line above it does
nothing:

```rust
// gitleaks:allow
let k = "...";                 // still fails

let k = "...";  // gitleaks:allow   // works
```

That is exactly how the pre-existing exemption in `parse.test.mjs` was written
— on its own line, two lines above the finding — which is why the file kept
failing the gate despite looking like it had been handled.

**Exact synthetic values — anchored regex entries in `.gitleaks.toml`.** The
reviewed literals use `\A` and `\z` anchors, with no path exemption. A new key
in the same file must still fail. In gitleaks 8.30.1 a global allowlist with
`condition = "AND"`, path and regex filters can prune the file before checking
the regex; that combination failed the different-value negative control.
Keep paths as explanatory descriptions rather than scanner filters.

Probe a file mentioned by an exact-value exception with a generated GitHub
token different from the reviewed literal, then remove the probe. It must
fail `github-app-token`. The reviewed literal must still pass. Run outside
ignored scratch directories so the scanner reads the fixture.

**Legacy fallback — a path entry in `.gitleaks.toml`.** Whole-file, so use it only
where a comment is impossible. Existing entries include JSON fixtures (no
comment syntax) and `Cargo.lock` (generated, so a comment is erased on the
next resolve). Prefer exact synthetic-value regex entries for new cases.

### What the path entries cost

They are whole-file, not per-rule. `targetRules` would have pinned each
exemption to the one rule it answers, but **it has no effect on rules
inherited through `[extend] useDefault` in gitleaks 8.28** — verified by
running the same scan with and without it and getting the same 12 findings
both times. There is no per-rule scoping available for default rules.

So a genuine credential pasted into a file on a path list would not be
caught. `.gitleaks.toml` has two such lists beside the build-output pruning:
the four files named above (three Bitwarden JSON fixtures and `Cargo.lock`) and
a longer list of synthetic fixtures the default rules flag. Keep the lists to
files whose entire contents someone has read, and reach for the inline comment
anywhere it is possible.

Also note `.gitleaks.toml` uses the plural `[[allowlists]]` form throughout:
gitleaks refuses to load a config that mixes it with the deprecated singular
`[allowlist]`.

## What was exempted, and why it is safe

The first set of exemptions, with every value decoded and read before being
listed. Later ones are in `.gitleaks.toml` (anchored exact-value regexes and
path lists) and in trailing `gitleaks:allow` comments (`rg 'gitleaks:allow'`):

| Where | Value | Verdict |
| --- | --- | --- |
| `apps/cli/src/bridge.rs`, `crates/pm-bridges/src/pairing.rs` | `id_key` base64-decodes to `12345678901234567890123456789012` | counting string |
| `crates/provider-bitwarden/tests/vectors/crypto_vectors.json` | master password `correct horse battery staple`; wrapped key decodes to `ZZZZZZZZZZZZZZZZ` | published KDF vectors |
| `crates/provider-bitwarden/tests/common/mod.rs` | a type-7 COSE EncString | synthetic migration fixture |
| `packages/app-core/.../cxf.test.ts`, `cxf.characterization.test.ts` | `-----BEGIN OPENSSH PRIVATE KEY-----` with no body; a key decoding to `private-key-this-vault-refuses` | header lines only |
| `packages/env-spec-bridge/test/parse.test.mjs` | a `sk_`-prefixed live-key placeholder | the test asserts this is **not** emitted |
| `Cargo.lock` | a crate checksum | not a credential |

A vector file has to contain key-shaped material or it cannot pin a KDF. That
is why these exist, and why the answer is to scope the exemption rather than
to change the fixtures.

## Git history

The gate warns on history findings and gates only on the working tree;
`OPENSESAME_GITLEAKS_HISTORY_FAIL=1` makes history findings fail it too.
`.gitleaks.toml` records the remediated commits it knows about (two today).
Rewriting history to clear any that remain is a separate decision that has not
been taken.
