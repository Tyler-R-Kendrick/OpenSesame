# tools/mutation

The Stryker configurations behind the TypeScript half of `pnpm test:mutation`,
and the Vitest configs Stryker drives. Each Stryker config names a small
`mutate` list of files where a surviving mutant means a security decision
stopped being made and nothing noticed. The break threshold is 100: one
surviving mutant fails the run.

## Where it fits

- **Read by:** `pnpm test:mutation:ts`, `pnpm test:mutation:duress` (root
  [`package.json`](../../package.json)). `pnpm test:mutation` runs
  `test:mutation:ts` and then the Rust half, `test:mutation:rust`
  (cargo-mutants, configured inline in `package.json`, not here).
- Not part of `pnpm verify` or CI. It is a test-depth suite run by hand.
- Reports land in `artifacts/mutation/`, which is gitignored.

## Files

| File | What it is |
|---|---|
| `stryker.config.json` | The main slice: redaction, URL trust boundaries, guest auth, the audit chain, identity linking, SIOP issuer and validity, the unlock duress gates, Pages keymap and tree motion. Runs related tests only (`vitest.related: true`). Report: `artifacts/mutation/typescript.json`. |
| `vitest.mutation.config.ts` | The Vitest config the main slice runs under: every `apps/**/src` and `packages/**/src` test, repository root as `root`, Pages' `test-setup.ts`, `OPENSESAME_ALLOW_DEV_DEFAULTS=1` so Identity suites boot. |
| `stryker.duress.config.json` | The three duress-unlock modules in `packages/app-core/src/screens/unlock/`, against a fixed test set (`related: false`). Report: `artifacts/mutation/duress-unlock.json`. |
| `vitest.duress-mutation.config.ts` | That fixed test set: the duress red-team suites in `packages/app-core/src/lib/duress/redteam/` and `apps/pages/src/lib/duress/redteam/gaps.honest.test.ts`. |

## Develop

```bash
pnpm test:mutation:ts                 # the main slice
pnpm test:mutation:duress             # the duress-unlock slice alone
pnpm test:mutation                    # TypeScript, then cargo-mutants
```

Adding a file to a `mutate` list is a claim that it is covered. Run the gate in
the same change and record the figure in
[`docs/validation/test-coverage.md`](../../docs/validation/test-coverage.md);
an entry whose gate has not run reads as covered while measuring nothing. A
file whose tests cannot run under the `node` environment here will report
uncovered mutants rather than real ones. Paths in the configs are
repository-relative because the Vitest configs set `root` to the repository
root.

## Related

- [`docs/validation/test-coverage.md`](../../docs/validation/test-coverage.md) — what belongs in the slice, measured scores, and what was deliberately left out
- [`docs/validation/test-strategy.md`](../../docs/validation/test-strategy.md) — where mutation sits in the test pyramid
