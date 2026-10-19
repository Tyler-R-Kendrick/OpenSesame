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
  `OPENSESAME_ENV_PARSE` to point the crate at another copy of the script; a
  released binary runs the bundle shipped beside it.
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

## Bundle

```bash
pnpm --filter @opensesame/env-spec-bridge bundle   # dist/opensesame-env-parse.mjs
node packages/env-spec-bridge/scripts/bundle.mjs <out>
```

`scripts/bundle.mjs` bundles the bridge and `@env-spec/parser` with esbuild
(the version `pnpm-lock.yaml` records: the root `pnpm.overrides` rewrite
esbuild's specifier, so `package.json` does not pin it) into one ES module that
imports only `node:` builtins: the `opensesame-env-parse.mjs` a
[release kit](../../docs/operators/release-kit.md) ships beside the
`opensesame` binary, which runs it from there with no `node_modules`. No
minification and no source map; `keepNames` keeps the parser's class names,
which the bridge reads; module paths in the output's comments are written as
they sit under this package's `node_modules`, so the same lockfile gives the
same bytes on any machine.

## Develop

```bash
pnpm --filter @opensesame/env-spec-bridge test     # node --test test/parse.test.mjs test/bundle.test.mjs
node packages/env-spec-bridge/bin/opensesame-env-parse.mjs tests/fixtures/demo.env.schema
```

Plain ESM JavaScript: no TypeScript, no `typecheck` script, and `build` is a
no-op. `test/bundle.test.mjs` bundles into a directory with no `node_modules`
above it, runs the bundle and the unbundled bridge on the repository's schemas
(`tests/fixtures/demo.env.schema`, `.env.schema`) and on keyed-argument,
sensitive and login schemas, and compares their output; it also bundles twice
to the same bytes and runs the bundle from a path with a space in it. `test/parse.test.mjs` asserts that a `sk_`-prefixed placeholder behind
`@sensitive` is not emitted; the gitleaks negative control
([`tools/security/gitleaks-negative-control.md`](../../tools/security/gitleaks-negative-control.md))
depends on that fixture.

## Related

- [ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md) — env-spec
  delivery modes
- [`docs/operators/local.md`](../../docs/operators/local.md) — developer
  `@env-spec` setup
- [`.env.schema`](../../.env.schema) — the repository's own schema
