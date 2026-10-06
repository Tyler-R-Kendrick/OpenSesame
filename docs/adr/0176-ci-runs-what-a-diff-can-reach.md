# ADR 0176 — CI runs what a diff can reach, and a push to main runs everything

Status: Accepted
Date: 2026-10-06
Supplements: ADR 0093 ([structural quality gates](0093-structural-quality-gates.md))

## Context

A pull request that deleted a settings toggle ran eleven browser shards, the
tutorials walk at two widths, the device walks and the Web Push job, and the
whole Pages unit suite (about 3,000 tests, ten minutes on a runner). The
required checks reported "failed" when a shard queued for fifteen minutes and
was cancelled, and nothing about the diff explained why any of that had to
run. A check that runs for a quarter of an hour on every change is not a gate
a person can iterate against.

## Decision

**A pull request runs the checks its diff can break and no others. A push to
`main` has no diff and runs every one.**

1. **Browser gates** (`scripts/lib/ci-gates.mjs`). Each added, modified or
   renamed path in the Pages build's area maps to the gates it can break, by
   rules that cite the AGENTS.md contract each gate enforces: a stylesheet
   starts the budget and phone shards; a settings panel starts the walks that
   open it; a file that mounts a guide target, a key binding or a settings
   view-model starts the tutorials walk; a driver under `apps/pages/scripts`
   starts the gates whose shard imports it. A path the rules cannot place
   starts every gate. Prose, tests and deletions start none. The matrix is
   written by `changes` from `scripts/lib/ci-bundle-shards.json`; a diff that
   reaches no shard skips the job, which the required check reads as passing.
2. **Unit tests** (`scripts/lib/ci-scoped-tests.mjs`). Typecheck still runs for
   every affected package. A package runs `vitest related` for the changed
   files, plus every test that reads the filesystem or spawns a tool, directly
   or through a helper (an import graph cannot see what a test reads by
   path). It runs whole when a manifest, config, lockfile or a file the test
   setup imports changed, and when its `test` script is not plain vitest.
   A changed file that more than 50 tests reach is a hub: its tests are
   followed two import steps rather than all the way, and the typecheck holds
   the rest of what it exports.
3. **Builds.** A browser job builds Pages without `tsc --noEmit`, which the
   TypeScript job runs for every package a diff reaches.
4. **The whole run** (`ci.yml` on `push` to `main` and `workflow_dispatch`).
   The same scripts, given no base to diff against, select every area, every
   shard, every job and every package. This is what proves a scoping rule
   dropped nothing: a regression the rules missed fails on `main` within one
   merge, not in the next pull request that happens to touch the file.

## Consequences

- A change to one panel runs a few shards and tens of test files, and finishes
  in minutes. A change to the boot path, a manifest or something no rule
  recognizes still runs everything.
- A new `verify-*` driver must be given a row in `DRIVER_GATES`
  (`ci-gates.test.mjs` fails without one); a new shard must name its gate
  (`gateOfShard`).
- Hub damping is a deliberate trade: a behavioural change in a hub file that
  only a test more than two steps away would catch surfaces on `main`, not on
  the pull request. The threshold and depth are `HUB_TESTS` and `HUB_DEPTH`.
- A package's test setup imports a wide closure (app-core's and Pages' reach
  `@opensesame/os-domain` and about 150 files once type-only imports are left
  out). A change inside it runs that package whole, because setup code runs
  before every test; the saving is for changes outside it. A type-only import
  (`import type`, `export type ... from`) is not followed: it is erased before
  the setup runs, and counting it put some 480 files, tutorial and capability
  type contracts among them, in the closure, so a one-line edit to one of those
  ran every test of the package.
- The tutorials walk is the slowest gate (about eight minutes whole), so CI
  splits it per width into three legs by tutorial id (`TUTORIALS_SHARD`,
  `shard.mjs`); the first leg also runs the passes that are not a tutorial.
  The experience journeys split in two the same way (`EXPERIENCE_SHARD`, the
  walks in turn). Each leg is a few minutes.
- The typecheck and the unit tests run side by side (`ci-run-lanes.mjs`), so
  a diff costs the longer of the two, not their sum.
- The rules are conservative by construction (unknown means all), so the cost
  of a wrong rule is extra work, never a skipped check, except where a rule
  names a narrower set on purpose; each of those cites the contract it follows.
