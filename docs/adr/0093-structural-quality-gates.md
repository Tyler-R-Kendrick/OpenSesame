# ADR 0093 — Structural quality gates: module size, complexity, and component coupling

Status: Accepted
Date: 2026-09-03
Supplements: ADR 0048 ([daemon dependency budget](0048-daemon-runtime-and-dependency-budget.md)),
ADR 0065 ([agent surface parity](0065-agent-surface-parity.md))

## Context

The repository measures a great deal — coverage floors that ratchet, mutation
scores, fuzzing, eight security gates, a design-control contract — and none of
it measures the shape of the code. On 2026-09-03 that showed:

- **380 of 1,950 source files exceeded 400 lines.** Three exceeded 4,000.
- `crates/storage/src/lib.rs` was **10,601 lines**, of which a single
  `impl Db` block was **5,292 lines and 215 methods** — connections, grants,
  receipts, E2EE sync blobs, the outbox, and the whole certificate-manager
  subsystem (CAs, issuance, ACME, EST, SCEP, signers, approvals, discovery,
  revocation) behind one type.
- `apps/pages/src/sections/AccessSection.tsx` was 4,161 lines with 15 functions
  over 100 lines.
- Nothing measured cyclomatic complexity on the TypeScript planes at all.
  Biome runs `recommended` only, which excludes
  `noExcessiveCognitiveComplexity`; Oxlint runs with every built-in category
  `off` because it hosts the anti-slop plugin.
- Nothing checked the component graph. `clippy.toml` already carried sensible
  per-function thresholds (`too-many-lines 100`, `too-many-arguments 7`,
  `excessive-nesting 4`), but Clippy has no per-file lint and
  `scripts/clippy-gate.sh` was not in CI.
- Nothing measured what the shipped bundles weigh, on a product whose flagship
  surface is an **installable offline PWA that precaches its whole dist**.

The obstacle to fixing this is not knowing what good looks like. It is that a
400-line budget turned on as a hard error fails 380 files at once, so it never
gets turned on.

## Decision

### 1. Reuse the linters already installed

Oxlint 1.79 — already a devDependency, already the anti-slop gate — implements
every metric wanted: `max-lines`, `max-lines-per-function`, `complexity`
(cyclomatic), `max-params`, `max-depth`, `max-nested-callbacks`,
`max-statements`. No new dependency is taken. `knip`, `madge`,
`dependency-cruiser` and `jscpd` were evaluated and rejected: they are
redundant against the above plus `cargo metadata`, and this repo runs a
dependency budget (ADR 0048).

Thresholds live in `oxlint.complexity.jsonc` and **mirror `clippy.toml`** so a
single complexity contract covers both planes:

| budget | TypeScript | Rust |
|---|---|---|
| lines per function | `max-lines-per-function` 100 | `too-many-lines` 100 |
| parameters | `max-params` 7 | `too-many-arguments` 7 |
| nesting | `max-depth` 4 | `excessive-nesting` 4 |
| cyclomatic | `complexity` 15 | `cognitive-complexity` 25 |
| **lines per file** | `max-lines` 400 | 400, counted by the gate |

Clippy has no per-file lint, so `scripts/quality-gate.mjs` applies the 400-line
file budget to `.rs` files itself. Rust *function* complexity is not
duplicated — `scripts/clippy-gate.sh` already owns it.

`max-lines-per-function` and `max-statements` are off for test files: a
`describe()` body legitimately spans a suite, and leaving them on buried 212
real production findings under 370 test-callback ones. The **file** budget
still applies to tests.

### 2. Ratchet the debt rather than snapshot it

`quality-baseline.json` records today's numbers. The gate fails when:

- a file exceeds its recorded number (**regression**), including a new file,
  whose recorded number is zero — so new code meets the budget outright; or
- a file improves and the baseline was not tightened in the same commit
  (**an unrecorded improvement**).

The second rule is what makes it a ratchet and not a snapshot. The recorded
numbers can only ever fall, so a baseline cannot silently rot, and touching a
bad file leaves it better than it was found.

For `max-lines` the recorded number is the file's **actual line count**, not a
count of violations. A boolean "this file is too long" made the ratchet blind
to the work that matters most: taking `lib.rs` from 10,601 lines to 2,275 left
the count at 1 and reported no improvement.

### 3. Enforce Martin's component principles on both planes

`scripts/package-metrics-gate.mjs` scores all 115 components — 60 pnpm
workspace packages and 55 Cargo crates — computing Ca, Ce, I = Ce/(Ca+Ce),
A (abstractness) and D = |A + I − 1|.

Two findings are **hard failures with no baseline**:

- **ADP — a dependency cycle.** Cyclic components cannot be built, tested,
  versioned or released independently, which dissolves the thing that makes
  them components. Found via Tarjan SCCs (O(V+E)); enumerating paths is
  exponential on a graph where `apps/gateway` depends on forty crates that also
  depend on each other.
- **A phantom dependency** — importing `@opensesame/x` without declaring it.
  It resolves only while pnpm's store happens to hoist it. Rust needs no
  equivalent; rustc already refuses it.

Two are real but negotiable, so they ratchet against
`package-metrics-baseline.json`: **SDP violations** (an edge pointing from a
more stable component to a less stable one) and **unused declared workspace
dependencies** (CRP/REP).

**SAP is reported, not gated.** Abstractness is counted syntactically here —
exported `interface`/`type` versus `class`/`function`/`const`, `pub trait`
versus `pub struct`/`enum`/`fn`. That is enough to spot a component sliding
into the zone of pain, not enough to fail a merge over. D is reported as `n/a`
for a component with no couplings, where I is 0/0 and the formula would
otherwise score every isolated leaf a maximally-distant 1.00.

### 4. Budget the shipped bundles

`bundle-budgets.json` holds explicit per-app KiB budgets, checked by
`scripts/bundle-budget-gate.mjs`. These are deliberately **not** auto-recorded:
a bundle legitimately grows when a feature lands, so raising a number must be a
reviewable line in a diff, not a regenerated file.

`apps/pages` is budgeted on both `total` and `javascriptGzip`, because 83% of
its 15,008 KiB is one file — the client-core Wasm sync engine at 12,509 KiB —
and a JavaScript regression would be invisible inside a total that large.

## Consequences

- `pnpm quality` (both ratchets, sub-second) joins `pnpm verify` and the CI
  TypeScript job. `pnpm quality:bundle` builds and measures in its own CI job.
- The opening debt is **850 tracked violations across 507 files**, 2 SDP edges,
  and 0 unused dependencies. Those numbers are in the repo and can only fall.
- 13 unused declared workspace dependencies were removed rather than recorded
  as accepted debt.
- `crates/storage/src/lib.rs` went from 10,601 lines to 2,275: the 215-method
  `impl Db` is now 22 modules, each one responsibility, none over 400 lines,
  and the test module is its own file. Rust spreads a type's inherent impl
  across modules of the same crate, so this was a pure move — no signature,
  no call site, and no behaviour changed.
- The split exposed two genuine misplacements that the single block had hidden:
  `count_expiring_within` sat with connections though only the certificate
  dashboard calls it, and `ensure_organization_row` is shared by seven modules
  and so belongs at the crate root. Both moved. Two methods went from private
  to crate-root-private; nothing became public.

## Alternatives considered

**Turn the budgets on as hard errors.** Fails 380 files on day one, so it would
be reverted or blanket-suppressed within a day.

**Record the debt without the tighten-or-fail rule.** This is the common
failure mode of baseline files: they capture a moment, drift, and stop meaning
anything. Requiring the baseline to move with the code is what keeps it honest.

**Add `knip` / `madge` / `dependency-cruiser`.** Three more devDependencies to
learn, configure and keep current, for checks that `cargo metadata`, the
workspace manifests and an already-installed Oxlint cover. Rejected on ADR
0048's reasoning.

**Gate SAP distance.** Abstractness cannot be measured honestly with a regex,
and a gate people do not believe is a gate people route around.
