# ADR 0200 — The anti-slop installer asset ships a manifest and a verifier

- **Status:** Accepted
- **Date:** 2026-10-13
- **Builds on:** [ADR 0093](0093-structural-quality-gates.md) (a gate that only
  ever falls), [ADR 0139](0139-one-definition-every-target.md) (one definition,
  a drift test in each consumer)

## Context

`skills/install-anti-slop` copies the vendored Oxlint plugin
(`assets/anti-slop`) into another repository. A consuming repository wants that
copy byte-identical to ours and wants to know, offline and without a network
fetch, when it stops being so: a hand edit to a rule, a half-applied update, a
deleted file. Nothing in the asset said what the right bytes were.

Separately, 17 of the asset's 39 files are RuleTester suites. A repository that
vendors the plugin as a lint dependency, and does not re-run our tests, does not
want them in its tree, and must still be able to verify what it did keep.

## Decision

1. **`MANIFEST.sha256` ships inside the asset.** One
   `<sha256-hex>  <path>` line per shipped file, paths relative to the plugin
   directory with `/` separators, sorted bytewise, LF endings, no line for
   itself. It is the format `sha256sum -c` reads, so a consumer without Node can
   check it too. It lists `verify.mjs`, so a changed verifier is drift as well.
2. **`verify.mjs` ships beside it and is copied by the installer.** It reads the
   manifest in its own directory and exits 1 with one sentence per problem: a
   missing, modified or extra file, a symbolic link, or a manifest line it cannot
   use (malformed, duplicated, naming itself, or naming a path outside the
   directory). Exit 2 is an unknown argument. It uses only Node.
3. **One manifest, two profiles, named by a flag.** `install.mjs --no-tests`
   leaves out every test-only path, and `verify.mjs --no-tests` does not expect
   them; under that flag a test file that is present is extra. Test-only means
   `*.test.*` and `*.spec.*` files and anything under `fixtures`, `__fixtures__`,
   `__snapshots__` or `__tests__`. The predicate (`isTestOnly`) is written once,
   in `verify.mjs`, and the installer imports it, so the two cannot disagree. The
   default install and the default verification are unchanged: tests included,
   same output byte for byte.
4. **The manifest is generated and its staleness fails the gate.**
   `pnpm anti-slop:manifest` rewrites it; `pnpm test:anti-slop` runs the same
   script with `--check` after the existing `diff -ru` parity check. That check
   leaves `MANIFEST.sha256` and `verify.mjs` out of the comparison, because the
   in-repository twin under `tools/oxlint/anti-slop` is the plugin source and
   the pair exists only in the distributed asset. A rule changed in both trees
   but not re-hashed fails the check and names the file.

Alternatives not taken:

- *A second manifest for the lean profile.* Two files to keep in step, and the
  lean one is a strict subset of the first.
- *A marker file written by the installer to say which profile was installed.*
  It is an extra file in a directory that is supposed to match a manifest, and
  the same bytes would no longer be what the asset holds.
- *Letting the verifier infer the profile from which tests are absent.* Deleting
  every test would then pass. A flag costs one word and keeps that visible; when
  a default verification finds test files missing it says to try `--no-tests`.
- *Marking test-only lines inside the manifest.* It breaks `sha256sum -c`.

## Consequences

- The manifest detects drift, not tampering. Whoever can edit a rule can edit the
  manifest, so a consumer that needs more pins the manifest's own digest wherever
  it pins other inputs.
- Changing any shipped file means running `pnpm anti-slop:manifest` in the same
  commit, as `tools/oxlint/README.md` already says for the twin tree.
- The test-only predicate is part of the contract. Widening it changes what
  `--no-tests` leaves out, and `scripts/lib/install-anti-slop.test.mjs` pins it,
  including a skill with a `fixtures/` directory and a `*.spec.ts` file.
