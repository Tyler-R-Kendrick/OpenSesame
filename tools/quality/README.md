# tools/quality

The ledgers and budgets the quality gates compare the tree against. Each file
records the debt or the size the repository carries today, and a gate script in
[`scripts/quality/`](../../scripts/quality) fails a change that makes it worse.
Three of the five are ratchets: their numbers may only fall, and a number that
falls must be recorded in the same commit.

## Where it fits

- **Read by:** `pnpm quality` (CI's TypeScript job and `pnpm verify`),
  `pnpm quality:bundle` (CI's Bundle budgets job) and `pnpm lint:design`
  (also `.githooks/pre-commit` on staged `.tsx`/`.css`).
- Never raise a recorded number to get a change through: split the file, drop
  the dependency, or replace the button. `--accept-new-debt` exists on
  `quality-gate.mjs` and is not a way around review
  ([ADR 0093](../../docs/adr/0093-structural-quality-gates.md), AGENTS.md §5).
- New files have no entry, which means zero: new code meets the budget outright.

## Files

| File | Read by | What it records | Direction |
|---|---|---|---|
| `quality-baseline.json` | `scripts/quality/quality-gate.mjs` (`pnpm quality:gate`) | Per file over budget: its line count (`max-lines`) and the number of violations of each other rule. Rust files are measured for size only; Clippy covers Rust functions. | Only falls. A file that improves fails the gate until `--update` records it. |
| `oxlint.complexity.jsonc` | `scripts/quality/quality-gate.mjs` | The Oxlint rule set the gate measures TypeScript with: `max-lines` 400, `max-lines-per-function` 100, `complexity` 15, `max-params` 7, `max-depth` 4, `max-nested-callbacks` 4, `max-statements` 40. Thresholds mirror `clippy.toml`. | Configuration, not a ledger. Separate from the root `oxlint.config.ts`, which is the anti-slop gate. |
| `package-metrics-baseline.json` | `scripts/quality/package-metrics-gate.mjs` (`pnpm quality:packages`) | Accepted SDP edges (dependencies toward instability) and unused declared workspace dependencies, across pnpm packages and Cargo crates. Cycles and phantom imports have no baseline: they always fail. | Only shrinks. A fixed edge fails until `--update` records it. |
| `design-button-baseline.json` | `scripts/quality/design-lint.mjs` (`pnpm lint:design`) | Word-verb buttons per file, keyed by path. Currently `{}`: none are allowed anywhere. | Only falls. A count that drops must be lowered by hand. |
| `bundle-budgets.json` | `scripts/quality/bundle-budget-gate.mjs` (`pnpm quality:bundle`) | KiB ceilings for `total`, `javascript`, `javascriptGzip`, `css` and `largestAsset` of the built `apps/pages`, plus the hardened capability-profile builds under `apps/pages/dist-profiles/`. | Not auto-recorded. A bundle may grow when a feature lands; raising a number is a hand-written line with a dated reason in the entry's notes. The profile budgets are ceilings to fall from, never raised to pass a build. |

## Develop

```bash
pnpm quality                        # tests for scripts/lib, then gate, packages, app-core
pnpm quality:gate --update          # record files that improved
pnpm quality:packages --update      # record SDP edges or unused deps that went away
pnpm quality:bundle                 # build pages/pwa/console, then check budgets
pnpm quality:report                 # every measurement, nothing gated
pnpm lint:design                    # design control contract, word-verb ledger
node scripts/quality/quality-gate.mjs --relocate <map.json>   # carry entries for moved files
```

`quality-baseline.json` is keyed by path, so a moved file looks like a new one
with a zero budget; `--relocate` re-keys its entries without letting any number
rise. The profile budgets are only measured when
`pnpm --filter @opensesame/pages build:profile` has produced
`apps/pages/dist-profiles/<name>`; otherwise the gate prints a skip notice.

## Related

- [ADR 0093](../../docs/adr/0093-structural-quality-gates.md) — structural quality gates
- [`docs/validation/code-quality-gates.md`](../../docs/validation/code-quality-gates.md) — the working guide
- [`docs/design/controls.md`](../../docs/design/controls.md) — the control contract `lint:design` enforces
