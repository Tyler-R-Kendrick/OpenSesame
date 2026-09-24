# tools/

Development tooling: things that check, measure or stand in for the product,
but never ship in it.

| Directory | What it is | Used by |
|---|---|---|
| [`oxlint/anti-slop/`](oxlint/anti-slop) | The vendored Oxlint anti-slop plugin: rules against unsafe type assertions, `unknown` leaking through APIs, module mocking and similar. A pnpm workspace package with its own RuleTester suite. | `pnpm lint:anti-slop`, `pnpm test:anti-slop`; installer copy in [`skills/install-anti-slop`](../skills/install-anti-slop) |
| [`quality/`](quality) | The ratchet ledgers the quality gates compare against: `quality-baseline.json` (file size and complexity), `package-metrics-baseline.json` (component coupling), `bundle-budgets.json` (built bundle sizes), `design-button-baseline.json` (word-verb buttons), and `oxlint.complexity.jsonc` (the complexity rule set). Numbers here may only fall. | `pnpm quality`, `pnpm quality:bundle`, `pnpm lint:design` |
| [`mutation/`](mutation) | Stryker configurations and the Vitest configs they drive, scoped to high-value files. | `pnpm test:mutation:ts`, `pnpm test:mutation:duress` |
| [`security/`](security) | Security-scanner configuration and its proof of life: the ast-grep rule set, negative controls showing the ast-grep and gitleaks gates can still fail, and the checklist PR security reviews apply. | `pnpm audit:ast-grep`, [`ops/routines/pr-security-review.md`](../ops/routines/pr-security-review.md) |
| [`mock-upstream-idp/`](mock-upstream-idp) | A deterministic OIDC provider on `:9090` that auto-approves a seeded user, so the Identity plane can be developed and tested without a real IdP. | `pnpm dev`, `pnpm --filter @opensesame/pages dev`, red-team and control-plane tests |
| [`eve-deepsec/`](eve-deepsec) | An [eve](https://eve.dev/) agent that runs the deepsec pattern scan and triages hits. Outside the pnpm workspace (it needs Node 24 and Zod 4). Config lives in [`.deepsec/`](../.deepsec). | `pnpm eve:deepsec` |

Configuration a tool looks up by a fixed name stays at the repository root:
`biome.json`, `oxlint.config.ts`, `clippy.toml`, `deny.toml`,
`osv-scanner.toml`, `.gitleaks.toml`, `rust-toolchain.toml`, `turbo.json`.

## The ratchets

`pnpm quality` compares the tree against the ledgers in `quality/` and fails
two ways: when something got worse than its recorded number, and when
something got **better** without the ledger being tightened in the same
commit. Tighten with `pnpm quality:gate --update`. Never raise a number to get
a change through — split the file instead
([ADR 0093](../docs/adr/0093-structural-quality-gates.md),
[working guide](../docs/validation/code-quality-gates.md)).
