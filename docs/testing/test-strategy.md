# Test strategy

What kinds of tests this repo runs, where each lives, and — for the kinds it
does not run — why, so the absence is a decision rather than an oversight.

## The kinds, and where they are

| Kind | Where | How it runs |
|---|---|---|
| Atomic unit | beside the code: `#[cfg(test)] mod tests` in Rust, `*.test.ts` in TS | `cargo test`, `pnpm test` |
| Property | `property: …` cases in the PACT suites | with the unit tests |
| Adversarial | `adversarial: …` cases — the ones that assert a refusal | with the unit tests |
| Chaos | `chaos: …` cases — retries, races, partial state, superseded work; scripted-fault network chaos in `crates/invoke-through/tests/chaos.rs` (+ daemon route cases) | with the unit tests |
| Contract | `contract: …` cases, plus `packages/contracts` schema tests | with the unit tests |
| Characterization / snapshot | `insta` snapshots in Rust (`src/snapshots/`), Vitest snapshots in TS (`__snapshots__/`) | with the unit tests |
| Behaviour (BDD) | `*.behavior.test.ts` — Given/When/Then journeys | with the unit tests |
| Integration | `test:integration` targets | `pnpm test:integration` |
| End-to-end | Playwright specs; `scripts/battle-test.sh`; `scripts/task-security-battle-test.sh` | `pnpm test:e2e`, `pnpm verify` |
| Fuzz | `cargo-fuzz` targets; Jazzer.js | `pnpm audit:fuzz`, `pnpm test:fuzz` |
| Mutation | Stryker (TS), `cargo-mutants` (Rust) | `pnpm test:mutation` |
| Model checking | Kani proofs, Miri, Shuttle | `pnpm audit:kani`, `audit:miri`, `audit:shuttle` |
| Security scanning | Semgrep, ast-grep, gitleaks, OSV, cargo-audit, CVE-lite | `pnpm audit:*` |
| Coverage measurement | `scripts/ts-coverage-gate.mjs`, `cargo llvm-cov` | `pnpm test:coverage` |

The PACT naming convention (`property:`, `adversarial:`, `chaos:`,
`contract:`) is load-bearing: it tells a reader which failure a case is about,
and it makes the adversarial cases — the ones asserting that something is
*refused* — greppable as a set.

## What the numbers mean, and what they do not

`pnpm test:coverage` runs a ratchet: a TypeScript gate
(`scripts/ts-coverage-gate.mjs`) and a Rust one (`cargo llvm-cov` with
`--fail-under-lines`). The thresholds exist to stop coverage sliding
backwards, which is the one thing a number is genuinely good for.

What they are *not* is a measure of whether something is tested. A threshold
read as a target invites tests written to move it, and those are worse than no
tests: they run code without asserting anything about it. This repo's suites
are judged on what they refuse, which coverage cannot see — a fence that stops
fencing executes exactly the same lines. Treat a passing ratchet as "nothing
got worse", not as "this is covered", and read the section below for the
question that actually matters.

Two numbers are expected to look low and are not defects:

- `packages/database` — the Postgres repository path needs a live database, so
  the in-memory implementation is what the unit suite exercises. The Postgres
  path is covered by `test:integration`.
- Anything whose branches are mostly typed-error mapping, where the assertion
  worth making is on the typed error, not on each arm.

## Mutation testing is the real coverage question

Coverage says a line ran. Mutation says a test would have *noticed* if that
line were wrong, which is the property this repo actually depends on: nearly
every security-relevant test exists to assert a refusal, and a refusal that
stops refusing still executes the same lines.

`pnpm test:mutation` runs Stryker over the TypeScript planes and
`cargo-mutants` over the pure decision crates — redaction, task-bus, relay,
connection-detect. It is scoped rather
than workspace-wide on purpose: a surviving mutant in a decision function is a
fence with no test behind it, while a surviving mutant in glue code is usually
noise, and drowning the first in the second helps nobody.

It is optional and not part of `pnpm verify`, which has to stay fast enough to
run before every push.

Measured when the gate was introduced:

| Crate | Result |
|---|---|
| `opensesame-relay` | 7/7 caught |
| `opensesame-connection-detect` | 48/49 caught, 1 unviable |

Both started worse, and the survivors were worth having. In `relay`, a mutant
lived on a condition that derived "an offline holder is refused" from the
availability class and the offline stance; the derivation happened to agree
with the rule for every case a test named, while quietly leaving a path where
an `A0Local` request would have been let through. The rule is now stated
outright and the test walks the whole class × stance matrix.

In `connection-detect`, half the mutants survived at first: the dotfile readers
had been extracted out of `connection-broker` without the tests that covered
them, so the behavior was still exercised through the broker but nothing local
would have noticed it breaking. That is the failure mode extractions produce
and coverage does not show — the lines still ran, in another crate's suite.

## Behaviour tests without a second framework

`*.behavior.test.ts` files are Given/When/Then journeys through whole flows —
a guest accepting a shared claim, an agent asking a person for authority. They
read as specifications and exist so the product's promises are legible without
reconstructing them from route handlers.

They deliberately do not use Cucumber or a `.feature` dialect. The value of a
behaviour spec is that it reads like one, and this achieves that with the test
runner already in use; a gherkin layer would add a parallel convention, a step
registry to keep in sync, and a second place to look for the truth. If these
specs ever need to be written or read by people who will not open a `.ts`
file, that trade changes and this decision should be revisited.

## Characterization snapshots

Snapshots pin what a surface *currently* produces so a change has to be looked
at and accepted. They do not assert the behavior is correct — the tests beside
them do that.

They earn their place where an unnoticed change is dangerous rather than
merely wrong:

- `apps/daemon` discovery report — the contract is that a provider is named
  and its credential never is, and the cheapest way to break it is to add a
  helpful-looking field.
- `packages/audit` redaction — what reaches an append-only trail. A key that
  stops appearing is an event quietly losing evidence; one that starts
  appearing may be a secret entering a log that is designed never to forget.

When one fails, read the diff before updating it. Accepting a snapshot without
reading it is worse than not having it, because it converts a question into a
rubber stamp.
