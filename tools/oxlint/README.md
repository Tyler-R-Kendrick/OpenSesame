# tools/oxlint

Home of the vendored Oxlint anti-slop plugin, the pnpm workspace package
`@opensesame/anti-slop` in [`anti-slop/`](anti-slop). Its rules reject patterns
that hide type holes: unsafe or chained type assertions, `unknown` leaking
through parameters, returns and aliases, runtime `typeof` checks, `Reflect`
dispatch, and module mocking in tests. It is the repository's strict TypeScript
lint gate beside Biome.

## Where it fits

- **Read by:** the root [`oxlint.config.ts`](../../oxlint.config.ts), which loads
  `anti-slop/index.ts` as a JS plugin, turns every built-in Oxlint category off
  and sets each `anti-slop/*` rule to `error`.
- **Run by:** `pnpm lint:anti-slop`, `.githooks/pre-commit` (staged files),
  `.githooks/pre-push`, and `pnpm verify`.
- **Mirrored in:** [`skills/install-anti-slop/assets/anti-slop`](../../skills/install-anti-slop/assets/anti-slop),
  the copy the install skill ships to other repositories. `pnpm test:anti-slop`
  fails unless the two trees are identical (ignoring `package.json`,
  `vitest.config.ts`, `LICENSE` and build output).
- MIT-licensed (`anti-slop/LICENSE`). Both copies are excluded
  from the lint they implement, because they contain the syntax they diagnose.

## Surface

| Path | What it is |
|---|---|
| `anti-slop/index.ts` | The `anti-slop` plugin: 15 rules, e.g. `no-chained-type-assertions`, `require-safety-comment-for-type-assertion`, `no-unknown-parameters`, `no-unknown-returns`, `no-module-mocking`, `no-runtime-typeof`, `no-reflect-get` |
| `anti-slop/rules/` | One file per rule, each with a RuleTester suite beside it (`*.test.ts`) |
| `anti-slop/effect/` | The opt-in `anti-slop-effect` plugin (`no-service-constructor-imports`); not enabled in `oxlint.config.ts` |
| `anti-slop/shared/` | Helpers the rules share: dictionary types, lexical type parameters, `Reflect` method matching |

## Develop

```bash
pnpm lint:anti-slop                          # lint the whole repository
pnpm lint:anti-slop:files <path>...          # lint specific files
pnpm test:anti-slop                          # mirror parity + typecheck + RuleTester suites
pnpm typecheck:anti-slop                     # tsc over index.ts and effect/index.ts
pnpm --filter @opensesame/anti-slop test     # RuleTester suites only
```

Change a rule in `anti-slop/` and copy the same change into
`skills/install-anti-slop/assets/anti-slop/` in one commit, or
`pnpm test:anti-slop` fails. A new rule needs its RuleTester suite, an entry in
`index.ts`, and an `error` line in `oxlint.config.ts`. The lint runs with
`--deny-warnings` and `--report-unused-disable-directives-severity=error`, so an
unused `oxlint-disable` comment fails it too. The RuleTester suites need Vitest
globals (`anti-slop/vitest.config.ts`).

## Related

- [ADR 0093](../../docs/adr/0093-structural-quality-gates.md) — structural quality gates; a second Oxlint config for complexity lives in [`tools/quality`](../quality)
- [`skills/install-anti-slop/SKILL.md`](../../skills/install-anti-slop/SKILL.md) — installing the plugin elsewhere
- [`docs/contributing/README.md`](../../docs/contributing/README.md) — where the gate sits among the others
