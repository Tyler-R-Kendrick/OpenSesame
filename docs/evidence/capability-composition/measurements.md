# Capability composition — measurements

Numbers read from the tools on 2026-09-27, when the verification #468/#470
carried (an earlier implementation of ADR 0130) was brought onto this one.
Each is re-runnable with the command beside it; none is a target by itself.

## Mutation (Stryker, `pnpm test:mutation:ts`)

The resolver's closure walk, its reason vocabulary and the always-on
withdrawal are in `tools/mutation/stryker.config.json`, at the repository's
break threshold of 100:

| File | Killed | Timed out | Survived | Score |
|---|---|---|---|---|
| `resolve-closure.ts` | 119 | 2 | 0 | 100.00 |
| `reasons.ts` | 19 | 0 | 0 | 100.00 |
| `resolve-withdraw.ts` | 30 | 5 | 0 | 100.00 |

Before the exact-pin tests (`resolve-closure.test.ts`, `reasons.test.ts`,
`resolve-withdraw.unit.test.ts`) the same three files scored 69.39 (57
survived). Four survivors were equivalent by the code's shape — a loop guard
the `pop()` already made redundant, a null check on a value only pushed, an
edge kind compared against one of its two values, a table built before any
mutant activates — and the code was reshaped so each is observable, rather
than annotated. #470's own slice was `resolver-node.ts`, 111/111.

## Coverage (`vitest run --coverage`, v8, `packages/capability-composition/src`)

| | Before | After |
|---|---|---|
| Statements | 91.45% | 92.23% |
| Branches | 87.54% | 89.05% |
| Functions | 98.54% | 99.04% |
| Lines | 92.55% | 92.84% |

#470 recorded 88.41% lines for its package.

## Fuzz (Jazzer.js, `tests/fuzz/jazzer/src/capability_composition.ts`)

Native Jazzer.js, 61 s: 144,465 runs, no finding. Over 5,000 random inputs the
generator's policies parse 58% of the time, 39% resolve with their selection,
and 15% approve optional capabilities — so the oracles (nothing unwanted or
prohibited approved; an unparsed policy approves nothing optional) see real
approvals. #470 recorded 11,788 runs.

## Properties (fast-check, seed 20260922)

`resolve.properties.test.ts`: order independence over random permutations of
every input list (200 runs), approved ⊆ closure of the selection and never
refused (400), and digest sensitivity (300 pairs; half differ). 32% of the
generated scenarios approve optional capabilities.
