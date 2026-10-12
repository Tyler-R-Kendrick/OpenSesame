# tools/

Development tooling: things that check, measure or stand in for the product,
but never ship in it.

| Directory | What it is | Used by |
|---|---|---|
| [`oxlint/anti-slop/`](oxlint/anti-slop) | The vendored Oxlint anti-slop plugin: rules against unsafe type assertions, `unknown` leaking through APIs, module mocking and similar. A pnpm workspace package with its own RuleTester suite. | `pnpm lint:anti-slop`, `pnpm test:anti-slop`; installer copy in [`skills/install-anti-slop`](../skills/install-anti-slop) |
| [`quality/`](quality) | The ratchet ledgers the quality gates compare against: `quality-baseline.json` (file size and complexity), `package-metrics-baseline.json` (component coupling), `anti-slop-baseline.json` (anti-slop findings), `log-hygiene-baseline.json` (log lines that bypass the scrubber), `design-button-baseline.json` (word-verb buttons) and `design-radius-baseline.json` (round corners), plus `bundle-budgets.json` (built bundle sizes) and `oxlint.complexity.jsonc` (the complexity rule set). The ledgers are ratchets whose numbers only fall; a bundle budget may be raised, with the reason recorded beside it. | `pnpm quality`, `pnpm quality:bundle`, `pnpm lint:design`, `pnpm lint:anti-slop` |
| [`mutation/`](mutation) | Stryker configurations and the Vitest configs they drive, scoped to high-value files. | `pnpm test:mutation:ts`, `pnpm test:mutation:duress` |
| [`security/`](security) | Security-scanner configuration and its proof of life: the ast-grep rule set, negative controls showing the ast-grep and gitleaks gates can still fail, and the checklist PR security reviews apply. | `pnpm audit:ast-grep`, [`ops/routines/pr-security-review.md`](../ops/routines/pr-security-review.md) |
| [`mock-upstream-idp/`](mock-upstream-idp) | A deterministic reference IdP on `:9090` (OIDC, plus SAML, a GitHub-shaped OAuth2 leg and an in-process LDAP server for tests) that auto-approves a seeded user, so the Identity plane can be developed and tested without a real IdP. | `pnpm dev`, `pnpm --filter @opensesame/pages dev`, control-plane tests |

Configuration a tool looks up by a fixed name stays at the repository root:
`biome.json`, `oxlint.config.ts`, `clippy.toml`, `deny.toml`,
`osv-scanner.toml`, `.gitleaks.toml`, `rust-toolchain.toml`, `turbo.json`.

## The ratchets

`pnpm quality` compares the tree against the structure, log-hygiene and
package-coupling ledgers in `quality/` (`pnpm lint:anti-slop` and
`pnpm lint:design` check the anti-slop and design ledgers) and fails two ways:
when something got worse than its recorded number, and when something got
**better** without the ledger being tightened in the same commit. Tighten with
`pnpm quality:gate --update` (the other ledgers tighten as
[`quality/README.md`](quality/README.md) describes). Never raise a number to get a change
through — split the file instead
([ADR 0093](../docs/adr/0093-structural-quality-gates.md),
[working guide](../docs/validation/code-quality-gates.md)).
