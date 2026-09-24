# General authority — verification evidence

Produced by `pnpm test:authority-fabric` (swarm **VERIFICATION**, work items
`TEST-STACK`, `TEST-SCENARIOS`, `TEST-RACES`, `TEST-PARITY`, `TEST-REPORT`).

Nothing in this directory records completed work. It records which contracts from
[`contract-registry.json`](../../implementation/general-authority/contract-registry.json)
are actually asserted by a test that ran, and — for every contract that is not —
the specific reason the harness could not settle it.

| Artifact | What it is |
|---|---|
| `authority-fabric-report.json` | The machine-readable report. Schema below. |
| `authority-fabric-report.md` | The same run rendered as a table. |
| [operators support matrix](../../operators/general-authority-support-matrix.md) | Honest enforcer/capability status |

## Running it

```bash
pnpm test:authority-fabric          # run and gate (non-zero while anything is blocked)
pnpm test:authority-fabric:report   # write the report, always exit 0
node scripts/test/authority-fabric-gate.mjs --no-run   # resolve statically, build nothing
```

The harness lives in `scripts/test/authority-fabric-gate.mjs` (collects facts, runs
tests, writes this directory) over three modules under `scripts/lib/`:
`authority-fabric-scenarios.mjs` (the registry), `authority-fabric.mjs` (pure
verdict logic), `authority-fabric-facts.mjs` (everything that reads the tree).
The pure logic has its own tests, picked up by `pnpm quality:test`
(`vitest run scripts/lib`), so the harness is verified rather than trusted.

## The one rule

**A scenario is green only when a named test, in a module reachable from its
crate root, ran and passed.** The harness cannot produce a pass any other way. In
particular it does not infer one from a file existing, from a module compiling,
from a suite's overall exit code, or from a sweep that found nothing to check.

## Status vocabulary

| Status | Meaning | Gate |
|---|---|---|
| `pass` | The named test ran and passed. | — |
| `fail` | The named test ran and its assertion did not hold. | fails |
| `blocked` | The harness could not settle the contract. | fails |
| `unsupported` | A declared limit of the harness, recorded with what would lift it. | counted apart |

`blocked` fails the gate deliberately. A gate that goes green on "not implemented
yet" is worse than no gate, so the programme's exit code stays non-zero until
every contract is either asserted or explicitly declared unsupported.

`unsupported` is not a quiet skip: it carries a `reason` and the condition that
would make it reachable, so it cannot be used to park a contract indefinitely
without that being visible in the report.

### Why a scenario was blocked

These distinguish "nobody wrote the test" from "the code does not build" from
"the harness itself cannot see the answer" — three very different pieces of work.

| Reason | Meaning |
|---|---|
| `crate-not-in-workspace` | The crate is absent from the Cargo workspace, so nothing in it compiles or runs. |
| `crate-lib-target-missing` | `Cargo.toml` declares a lib target whose file does not exist. |
| `module-not-declared` | The module is on disk but no `mod` declaration reaches it from the crate root, so its `#[test]` functions never run. Comments are stripped first: a declaration parked inside `/* WIP ... */` does not count. |
| `build-failed` | The crate would not compile. Nothing was asserted either way, so this is not a `fail`. |
| `no-test-asserts-contract` | The module compiles but the named test does not exist, is `#[ignore]`d, or printed no result. |
| `test-enumeration-failed` | `cargo test --list` failed; the detail carries rustc's own error headlines. |
| `test-file-missing` | The TypeScript test file the scenario names does not exist. |
| `suite-failed-to-run` | The suite errored before collecting, so zero assertions ran. Not the same as the test being absent. |
| `vacuous-no-subject` | A sweep found nothing to check. Recorded as blocked, because a sweep with no subject proves nothing. |
| `second-local-ledger-present` | A module under `apps/pages/src/lib` whose name is in the authority family (`grant`, `share`, `authority`, `rbac`, `permission`) appears in neither `declared` nor `notLedgers` of `local-ledger-inventory.json`. The filename signal cannot tell a rival ledger from a different concern — `local-grant-store.ts` holds application OIDC grants and is legitimately not the ledger — so the ask is to classify it with a reason, not to delete it (INV-GA-10). |
| `live-stack-not-configured` | A `live` scenario's stack was not configured. A live result is never inferred from a unit run. |
| `harness-missing` | The harness a contract needs does not exist yet, named in the detail. |
| `harness-error` | The harness itself misbehaved. Always a defect here, never in the code under test. |
| `not-executed` | `--no-run` was passed. |

## Tiers

A tier is what a scenario *needs at run time*. It is not a severity and not an
ordering, and one tier's result is never read as another's.

| Tier | Needs |
|---|---|
| `unit` | One compiled module, in process, no I/O beyond the repository. |
| `integration` | Two or more subsystems in one process (domain plus storage, a route plus its store). |
| `provider` | A real provider adapter or external policy engine (OpenFGA, OpenBao). |
| `live` | A running stack over the network (Host API `:8787`, Identity API `:8788`). |
| `unsupported` | Nothing in this repository can express it at this commit; the reason says what would. |

## Report schema

```
programme, swarm, workItems     which swarm produced this and under which items
generatedAt, head, treeDirty    when, and against which commit
treeChangedDuringRun            true if the tree moved mid-run — see below
executed                        false under --no-run
cargoExecution                  how Rust scenarios were executed
tierVocabulary, statusVocabulary the closed vocabularies above
summary.total                   scenario count
summary.byStatus                counts per status
summary.byTier                  per tier, counts per status
summary.gate                    pass | blocked | fail
scenarios[]                     one entry per scenario:
  id, workItem, area, tier      identity and classification
  invariant                     the INV-GA-NN contract it settles
  title                         the contract in one sentence
  status, reason, detail        the verdict and the evidence for it
  reproduce                     the command that settles this one scenario alone
```

Rust scenarios are executed as one `cargo test -p <crate> --lib` per crate and
each scenario reads its own test's line, so scenarios sharing a crate are
answered from the same build. `reproduce` still names the single-test command, so
any one row can be checked on its own.

### `treeChangedDuringRun`

Several swarms write while this runs. When `git status` differs between the start
and end of a run, scenarios were resolved against different states and **cannot
be compared with one another** — the same crate can compile for one scenario and
fail to build for the next. When this flag is true, re-run against a still tree
before reading any single row as settled.
