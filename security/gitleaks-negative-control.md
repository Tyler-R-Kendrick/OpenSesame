# gitleaks gate — negative control

`pnpm audit:gitleaks` reports the working tree clean. Twenty-three findings
were exempted to get there, so this is how to confirm the scanner still works,
and what the exemptions actually cost.

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

Two mechanisms, and the choice between them is not stylistic.

**Preferred — a trailing `// gitleaks:allow` on the offending line.** Only that
line is exempt; the rest of the file stays scanned. Eight findings use this.

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

**Fallback — a path entry in `.gitleaks.toml`.** Whole-file, so use it only
where a comment is impossible. Four files qualify: three JSON fixtures (no
comment syntax) and `Cargo.lock` (generated, so a comment is erased on the
next resolve).

### What the path entries cost

They are whole-file, not per-rule. `targetRules` would have pinned each
exemption to the one rule it answers, but **it has no effect on rules
inherited through `[extend] useDefault` in gitleaks 8.28** — verified by
running the same scan with and without it and getting the same 12 findings
both times. There is no per-rule scoping available for default rules.

So a genuine credential pasted into one of those four fixtures would not be
caught. Keep the list to files whose entire contents someone has read, and
reach for the inline comment anywhere it is possible.

Also note `.gitleaks.toml` uses the plural `[[allowlists]]` form throughout:
gitleaks refuses to load a config that mixes it with the deprecated singular
`[allowlist]`.

## What was exempted, and why it is safe

Every value was decoded and read before being listed:

| Where | Value | Verdict |
| --- | --- | --- |
| `apps/cli/src/bridge.rs`, `apps/pm-bridges/src/pairing.rs` | `id_key` base64-decodes to `12345678901234567890123456789012` | counting string |
| `crates/provider-bitwarden/tests/vectors/crypto_vectors.json` | master password `correct horse battery staple`; wrapped key decodes to `ZZZZZZZZZZZZZZZZ` | published KDF vectors |
| `crates/provider-bitwarden/tests/common/mod.rs` | a type-7 COSE EncString | synthetic migration fixture |
| `apps/pages/.../cxf.test.ts`, `cxf.characterization.test.ts` | `-----BEGIN OPENSSH PRIVATE KEY-----` with no body; a key decoding to `private-key-this-vault-refuses` | header lines only |
| `packages/env-spec-bridge/test/parse.test.mjs` | a `sk_`-prefixed live-key placeholder | the test asserts this is **not** emitted |
| `Cargo.lock` | a crate checksum | not a credential |

A vector file has to contain key-shaped material or it cannot pin a KDF. That
is why these exist, and why the answer is to scope the exemption rather than
to change the fixtures.

## Git history

The gate warns on history findings and gates only on the working tree. History
currently reports ~70, from commits already recorded as remediated in
`.gitleaks.toml`. Rewriting history to clear them is a separate decision that
has not been taken.
