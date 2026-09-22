# Capability composition — integration evidence

Chain: registry (`@opensesame/capability-registry` CAPABILITIES) →
catalog (`apps/pages/src/lib/composition/catalog.ts`) → preset
(`@opensesame/capability-composition` presets) → resolver → loader table
→ flags → leases → variant caches.

## Measured 2026-09-22 (Wave 4, S00)

Pure package (`@opensesame/capability-composition`, v8, `src/**/*.ts`):

| Metric | Measured |
| --- | --- |
| Statements | 86.51% |
| Branches | 83.52% |
| Functions | 92.85% |
| Lines | **88.41%** (floor: 50% per package) |

`resolver-node.ts`: 100/100/100/100. `resolver.ts`: 98.43% lines.
`index.ts`/`lifecycle.ts` at 0% by construction (re-exports + types only).

Mutation (Stryker, `resolver-node.ts`): **111/111 killed, score 100.00**,
registered in `stryker.config.json`.

Fuzz (Jazzer.js, `capability_composition` target): **11,788 runs, no crash**.

Pages suite: **3981 passed / 70 skipped** (full run, Wave 3 close).

## Fixtures

- `fixtures.integration.test.ts`: personal + family presets resolve
  hardened (no prohibited loads, every loaded id in the loader table,
  every flag matches activation).
- `chain.adversarial.test.ts` (S23): hostile catalog, smuggled
  prohibited id, allow-nothing vault, foreign-vault selection — all fail
  closed with nothing loaded.

## Approval

`packages/capability-composition/src/__snapshots__/plan.approved.md`
pins the multi-branch plan rendering (Verify equivalent).
