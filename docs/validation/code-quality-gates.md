# Structural quality gates

These gates measure the *shape* of the code, alongside the coverage and
security gates that measure its behaviour. The decision behind the structural
ones, and why each threshold is what it is, is
[ADR 0093](../adr/0093-structural-quality-gates.md).

| Gate | Command | In `pnpm verify` | In CI |
| --- | --- | --- | --- |
| Gate self-tests | `pnpm quality:test` | yes | yes (TypeScript job) |
| Module size + complexity | `pnpm quality:gate` | yes | yes (TypeScript job) |
| Log hygiene | `pnpm quality:log-hygiene` | yes | yes (TypeScript job) |
| Component coupling | `pnpm quality:packages` | yes | yes (TypeScript job) |
| Shared core | `pnpm quality:app-core` | yes | yes (TypeScript job) |
| Bundle budgets | `pnpm quality:bundle` | no (needs builds) | yes (its own job) |

`pnpm quality` runs the first five together; bundle budgets need a build and
run apart. `pnpm quality:report` prints the structure, coupling and bundle
measurements without gating.

`pnpm quality:test` runs the Vitest suites under `scripts/lib` and the
`node --test` suites under `scripts/security`. They include
`scripts/lib/martin-metrics.test.mjs` — the Tarjan cycle search and the
coupling arithmetic. A gate that silently stops detecting is worse than no
gate, so the detection logic is tested like any other code.

## 1. Module size and complexity — `pnpm quality:gate`

Budgets. The function-length, parameter and nesting values deliberately
mirror `clippy.toml` (`too-many-lines-threshold`, `too-many-arguments-threshold`,
`excessive-nesting-threshold`) so one contract covers both planes:

| Budget | Value | Enforced on |
| --- | --- | --- |
| `max-lines` (per file) | 400 | `.ts` `.tsx` `.js` `.mjs` `.rs` |
| `max-lines-per-function` | 100 | TypeScript (off in test files) |
| `complexity` (cyclomatic) | 15 | TypeScript |
| `max-params` | 7 | TypeScript |
| `max-depth` | 4 | TypeScript |
| `max-nested-callbacks` | 4 | TypeScript |
| `max-statements` | 40 | TypeScript (off in test files) |

TypeScript is measured by Oxlint through `tools/quality/oxlint.complexity.jsonc`. Rust file
size is counted by the gate — Clippy has no per-file lint. Rust *function*
complexity is `pnpm audit:clippy`'s job and is not duplicated here.

### The ratchet

`tools/quality/quality-baseline.json` is a debt ledger, not a suppression list. The gate
fails two ways:

```
quality gate: FAIL -- 1 structural regression(s)
  packages/policy/src/big.ts
      max-lines: allowed 0, found 420
```

A file exceeded its recorded number. A file with no entry has a recorded
number of zero, so **new code must meet the budget outright**. Split the file
or shrink the function; do not raise the number.

```
quality gate: FAIL -- 1 improvement(s) not recorded
  crates/storage/src/lib.rs
      max-lines: 10601 -> 2275
```

A file got better and the ledger still claims the old number. Record it:

```bash
pnpm quality:gate --update
```

Commit the tightened baseline with the change that earned it. This is what
makes the ledger a ratchet: recorded numbers only ever fall.

`--update` **refuses to raise a recorded number**, so it cannot be used to make
a regression disappear:

```
quality gate: refusing to update -- 1 recorded number(s) would go UP
  crates/storage/src/lib.rs
      max-lines: 2186 -> 2400
```

Split the file instead. If the debt is genuinely unavoidable, say so
explicitly with `pnpm quality:gate --update --accept-new-debt` — which is
greppable in CI logs, and shows up as a number going *up* in the diff.

**Relocation needs the same override.** Splitting one oversized file into
several removes its entry and adds one per piece, so the gate sees new
entries even though nothing got worse. Tell the two apart with the totals
block in the baseline diff:

| total | meaning |
| --- | --- |
| `files` | how many files carry any recorded violation |
| `violations` | one per oversized file, plus each occurrence of the other rules — this *rises* on a split, because one bad file becomes several smaller ones |
| `oversizedLines` | every recorded line count added up — this is the one that falls when debt shrinks, and stays flat when it merely moves |

A split should leave `oversizedLines` flat or lower. If it rose, something
actually grew.

**A plain move does not need the override** (ADR 0133 §6). When a file only
changes path — `git mv`, content unchanged or improved — carry its recorded
entry instead of re-accepting it:

```bash
pnpm quality:gate --relocate relocation-map.json
# relocation-map.json: { "moves": { "old/path.ts": "new/path.ts" } }
```

`--relocate` re-keys each moved file's entry and then records the ledger the
way `--update` does, including the refusal to let any number rise. It
refuses a map entry whose old path still exists or whose new path already has
an entry. It cannot be combined with `--accept-new-debt`. A moved file that
also got worse still fails; one that got better still has to record the
improvement.

For `max-lines` the recorded number is the file's line count, so partial
progress counts. Every other rule records occurrences.

`pnpm quality:gate --summary` lists the worst files without gating.

## 2. Component coupling — `pnpm quality:packages`

Scores all 137 components — pnpm workspace packages and Cargo crates — against
Robert C. Martin's component principles. See `scripts/lib/martin-metrics.mjs`
for the definitions.

**Hard failures, no baseline:**

- **ADP — a dependency cycle.** Components in a cycle cannot be built, tested,
  versioned or released independently.
- **A phantom dependency** — source imports `@opensesame/<name>` but the manifest
  does not declare it. It works only while pnpm's store hoists it. Checked for
  the TypeScript plane; rustc already refuses an undeclared crate.

**Ratcheted against `tools/quality/package-metrics-baseline.json`** (same tighten-or-fail
rule as above, via `pnpm quality:packages --update`):

- **SDP violations** — an edge from a more stable component to a less stable
  one, so a change ripples backwards.
- **Unused declared workspace dependencies** — CRP/REP debt.

**Reported, not gated:** `pnpm quality:packages --report` prints Ca, Ce, I, A
and D per component, sorted by distance from the main sequence. Abstractness is
counted syntactically, which is enough to spot a component drifting into the
zone of pain (stable and concrete, high Ca with low A) and not enough to fail
a merge over. D shows `n/a` for a component with no couplings, where I is 0/0.

## 3. The shared core — `pnpm quality:app-core`

Checks `packages/app-core` and `packages/vault-core` (ADR 0133). Every rule
is a hard failure except the lazy-cycle ledger, which only shrinks.

- **Boundary.** No relative import leaves the package (the repository's
  `spec/` and `tests/fixtures/` excepted), no React value import (a
  type-only one is allowed and counted), no `import.meta.env` (read
  `env()`), no Vite `virtual:` module, no self-import by package name, and
  `node:*` only under `src/node/**` and in tests.
- **Portability.** Using the TypeScript checker, no value reference to a
  browser-only global — anything declared by the DOM or WebWorker libs —
  outside `src/browser/**`, worker entries (`*.worker.ts`) and tests, unless
  it is in the runtime contract every host provides (`crypto`, `fetch`,
  `URL`, `TextEncoder`, timers, …; `RUNTIME_CONTRACT` in
  `scripts/lib/app-core-portability.mjs`). Type positions do not count.
  Everything else goes through a port in `src/ports.ts`. vault-core has no
  browser host, so it may use none.
- **Layering.** No cycle of static imports. A lazy `import()` that closes a
  loop is recorded in `packages/app-core/layering-baseline.json`; a new one
  fails, and one that disappears fails until it is struck
  (`node scripts/quality/app-core-boundary.mjs --update`).
- **Restricted seams.** Checked over the whole repository, not one package: a
  seam a module exports for its owner and tests alone
  (`RESTRICTED_SEAMS` in `scripts/lib/app-core-seams.mjs`, ADR 0160 §5a) may
  be imported by no one else, in any package or app.

Two tests hold the runtime side: `packages/app-core/src/no-host-import.test.ts`
imports every module with no host installed (a port read at import fails),
and `src/sandbox/bare-isolate.test.ts` runs the portable entry in an empty V8
context against the golden vault vectors.

## 4. Bundle budgets — `pnpm quality:bundle`

Builds `apps/pages`, then measures `total`,
`javascript`, `javascriptGzip`, `css` and `largestAsset` against
`tools/quality/bundle-budgets.json`.

Unlike the two ratchets these budgets are **not** auto-recorded. A bundle
legitimately grows when a feature lands, so raising one is a reviewable line
in a diff with a reason — never a regenerated file.

`apps/pages` is the case that matters: it is an installable offline PWA
(ADR 0090) whose service worker precaches the whole dist, so `total` is what
every installing device downloads. It is budgeted on `javascriptGzip` as well
as `total` because 83% of that total is one 12.5 MiB Wasm file, and a
JavaScript regression would be invisible inside it.

## 5. Anti-slop ledger — `pnpm lint:anti-slop`

The anti-slop rules in the root `oxlint.config.ts` apply at two scopes:

- **Touched files, zero tolerance.** `pnpm lint:anti-slop:files <paths>` fails
  on any finding. `.githooks/pre-commit` runs it on staged sources, so any file
  a commit touches has to be clean.
- **The whole tree, ratcheted.** `pnpm lint:anti-slop`
  (`scripts/quality/anti-slop-gate.mjs`, in `pnpm verify` and the default
  pre-push hook) lints every file and compares the per-file, per-rule counts
  with `tools/quality/anti-slop-baseline.json`. That ledger records the findings
  the tree still had when the full-repository gate was introduced.

The gate fails on:

- a file or rule with no entry;
- a count above its recorded number;
- an unused disable directive, which is never ledgered;
- a count below its recorded number that has not been recorded yet.

`pnpm lint:anti-slop --update` records improvements: it lowers counts, drops
entries that reach zero, and drops deleted files. It refuses a run that would
raise a count or add an entry, and it has no override. Fix a finding by
rewriting the flagged construct, never with a disable comment.

The full run takes several minutes. Most of that time is
`anti-slop/no-unsafe-dictionary-type`, which builds a TypeScript program for
each file. The gate therefore splits the file list across one single-threaded
Oxlint process per core; `ANTI_SLOP_JOBS=<n>` overrides the number of
processes. The comparison logic is tested in
`scripts/lib/anti-slop-ledger.test.mjs`, which `pnpm quality:test` runs.

## 6. Log hygiene — `pnpm quality:log-hygiene`

Keeps every log line behind the shared scrubber (ADR 0157).
`scripts/quality/log-hygiene-gate.mjs` counts, per production file, the ways
code goes around the shared logger: `console.*`, a hand-built `pino(...)`, a
direct `process.stdout`/`process.stderr` write, and a tracing subscriber or
fmt layer built without the scrubbing writer. A file or kind with no entry in
`tools/quality/log-hygiene-baseline.json` is allowed zero, and a recorded
number only falls: `pnpm quality:log-hygiene --update` records improvements and
refuses to raise a number. `--update --accept-new-debt` records only the sites
a widened detector newly counts (a file or kind with no entry yet).

## Working with the gates

Adding a feature to an already-oversized file:

1. `pnpm quality:gate` tells you what you exceeded.
2. Move the new code into a new module under 400 lines, or split a seam out of
   the old one first.
3. If the file shrank, `pnpm quality:gate --update` and commit the ledger.

Adding a workspace package: declare every `@opensesame/*` you import, and
import every one you declare. The gate checks both directions.
