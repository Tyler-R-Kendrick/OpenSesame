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
  and sets each `anti-slop/*` rule to `error`. The same config also loads the
  `@gdp-ts/core` lint that bans forging an authorization proof
  ([ADR 0178](../../docs/adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md)),
  so `pnpm lint:anti-slop` enforces both.
- **Run by:** `pnpm lint:anti-slop`, `.githooks/pre-commit` (staged files),
  `.githooks/pre-push`, and `pnpm verify`.
- **Mirrored in:** [`skills/install-anti-slop/assets/anti-slop`](../../skills/install-anti-slop/assets/anti-slop),
  the copy the install skill ships to other repositories. `pnpm test:anti-slop`
  fails unless the two trees are identical (ignoring `package.json`,
  `vitest.config.ts`, `LICENSE`, build output, and the two files only the
  shipped copy carries, `MANIFEST.sha256` and `verify.mjs`).
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
`skills/install-anti-slop/assets/anti-slop/`, then run `pnpm anti-slop:manifest`
to re-hash the shipped copy, all in one commit, or `pnpm test:anti-slop` fails. A new rule needs its RuleTester suite, an entry in
`index.ts`, and an `error` line in `oxlint.config.ts`. The lint runs with
`--deny-warnings` and `--report-unused-disable-directives-severity=error`, so an
unused `oxlint-disable` comment fails it too. The RuleTester suites need Vitest
globals (`anti-slop/vitest.config.ts`).

## Install it in another repository

The shipped copy is an installable, verifiable asset
([ADR 0200](../../docs/adr/0200-anti-slop-asset-ships-a-manifest-and-a-verifier.md)).
From the consuming repository, `node <this repo>/skills/install-anti-slop/scripts/install.mjs [dest]`
copies it to `tools/oxlint/anti-slop` (or `dest`); add `--no-tests` to leave out
the RuleTester suites and any other test-only file. `node <dest>/verify.mjs`
(with `--no-tests` for that install) checks the copy against its
`MANIFEST.sha256` offline and exits 1 with one sentence per missing, modified or
extra file. After changing a rule here, `pnpm anti-slop:manifest` rewrites the
manifest and `node skills/install-anti-slop/scripts/manifest.mjs --check` (run
by `pnpm test:anti-slop`) fails when it is stale.

## Related

- [ADR 0093](../../docs/adr/0093-structural-quality-gates.md) — structural quality gates; a second Oxlint config for complexity lives in [`tools/quality`](../quality)
- [`skills/install-anti-slop/SKILL.md`](../../skills/install-anti-slop/SKILL.md) — installing the plugin elsewhere
- [`docs/contributing/README.md`](../../docs/contributing/README.md) — where the gate sits among the others
