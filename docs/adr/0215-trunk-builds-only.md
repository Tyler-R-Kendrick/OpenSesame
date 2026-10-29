# ADR 0215 — Trunk only builds the impacted graph

- **Status:** Accepted
- **Date:** 2026-10-29
- **Amends:** [ADR 0214](0214-trunk-ci-artifact-promotion.md), integration scope
- **Operating contract:** [CI and artifact promotion](../operators/ci-promotion.md)

## Context

Affected tests, browser trust journeys, lint, typechecks and budget gates still
made every integration wait for delivery qualification. The TypeScript job even
needed a three-hour timeout. Tests must qualify environment delivery while trunk
continues integrating buildable changes.

## Decision

PR, merge-group and main CI only compile changed TypeScript packages and Rust
crates, their transitive consumers and necessary build prerequisites. Shared
inputs or unreadable diffs select a full build; docs and lint-only changes do
not compile anything. Preserve cumulative main scope and strict result reporting.

Git hooks own lint, standalone typechecking and static quality checks. Default
push verification runs no tests. Build scripts do not add separate no-emit
TypeScript checks; compiler work that emits library build artifacts remains.
GitHub's signature ruleset remains in force.

Development delivery retains the full TypeScript/Postgres suite and immutable
artifact smoke. Prerelease retains browser/native/profile coverage, budgets,
sync authorization and autofill. Release qualification retains mutation and
security. Auxiliary test/security workflows have reusable/manual entry points
instead of automatic trunk triggers; independent scheduled monitoring remains.

Keep existing required check names for ruleset and candidate-admission
compatibility. The legacy Bundle budgets reporter mirrors the TypeScript build;
actual budgets qualify delivery. A name migration needs a coordinated settings
and candidate-admission change.

## Consequences

A buildable change can integrate before its tests qualify an environment.
Delivery failure stops promotion of that candidate while main keeps moving.
Contributors install hooks through bootstrap or `pnpm setup:hooks`; they may
explicitly request the full local verify suite. Hosted runs are still needed to
measure latency and establish actual candidate qualification.
