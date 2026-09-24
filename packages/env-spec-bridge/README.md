# @opensesame/env-spec-bridge

A Node bridge from `.env.schema` to JSON for the Rust plane. The one binary,
`opensesame-env-parse`, parses a schema file with the upstream
`@env-spec/parser` and prints each item's key, `@type`, `@required`,
`@sensitive` and `@public` decorators, and its resolver call. A sensitive
item's static value is never printed.

## Where it fits

- **Used by:** the Rust crate [`crates/env-spec`](../../crates/env-spec)
  (`opensesame-env-spec`), which runs this script on a bare Node and parses
  its output; through it, the Host CLI's `dev check --schema`. Set
  `OPENSESAME_ENV_PARSE` to point the crate at another copy of the script.
  No TypeScript package imports it.
- **Builds on:** `@env-spec/parser` (pinned at `0.4.1`), in place of an
  in-house parser.

## Surface

```bash
opensesame-env-parse <path-to-.env.schema>   # JSON on stdout; exit 2 without a path
```

Output shape: `{ schema_path, parser: "@env-spec/parser", items: [{ key,
sensitive, required, public, type, value, resolver, decorators }] }`, with
`value` null whenever `sensitive` is true. The module also exports
`parseSchemaFile(file)` and `main(args)`.

## Develop

```bash
pnpm --filter @opensesame/env-spec-bridge test     # node --test test/parse.test.mjs
node packages/env-spec-bridge/bin/opensesame-env-parse.mjs tests/fixtures/demo.env.schema
```

Plain ESM JavaScript: no TypeScript, no `typecheck` script, and `build` is a
no-op. `test/parse.test.mjs` asserts that a `sk_`-prefixed placeholder behind
`@sensitive` is not emitted; the gitleaks negative control
([`tools/security/gitleaks-negative-control.md`](../../tools/security/gitleaks-negative-control.md))
depends on that fixture.

## Related

- [ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md) — env-spec
  delivery modes
- [`docs/operators/local.md`](../../docs/operators/local.md) — developer
  `@env-spec` setup
- [`.env.schema`](../../.env.schema) — the repository's own schema
