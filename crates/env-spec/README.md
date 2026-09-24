# opensesame-env-spec

The Host plane's consumer of `.env.schema` files. It does not reimplement the
`@env-spec` DSL: it runs the Node bridge in
[`packages/env-spec-bridge`](../../packages/env-spec-bridge), reads the JSON
that `@env-spec/parser` emits, and resolves each item under a
`DevDeliveryPolicy`: plain non-sensitive values pass through, a connection
resolver becomes a handle (or a placeholder projection where the schema asks
for one), and a sensitive value is materialized only when policy allows it. A schema summary safe for agents and logs carries no values.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`opensesame dev`, the developer
  `@env-spec` workflow), [`opensesame-host-core`](../host-core) (re-exported as
  `host_core::env_spec`), and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`env_spec`).
- **Builds on:** [`opensesame-domain`](../domain) (`DevDeliveryPolicy`,
  `CredentialDeliveryMode`, `LegacyProjection`) and, at runtime, `node` plus the
  bridge script.
- `resolve_for_delivery` never materializes a secret without a policy allow;
  with `agent` set, materialization is denied and the item is omitted with a
  warning.
- The bridge runs with `NODE_OPTIONS` removed, so an inherited `--import` or
  `--require` cannot load other code into the process that reads configuration.
- Placeholder suffixes are random per projection.

## Surface

| Item | What it is |
|---|---|
| `parse_schema_file(path)` | Runs `node packages/env-spec-bridge/bin/opensesame-env-parse.mjs <path>`; `OPENSESAME_ENV_PARSE` overrides the script path |
| `parse_schema_json(json)` | Parses bridge output already in hand |
| `schema_summary(doc)` | Per item: key, sensitive / required / public flags, resolver name, whether a value is present — never the value |
| `resolve_for_delivery(doc, policy, agent)` | `Vec<ResolvedEnvEntry>` with delivery mode, connection ref, projection, `omitted` and `warning` |
| `EnvSpecDocument`, `EnvSpecItem`, `EnvDecorator`, `EnvResolver`, `EnvResolverArg` | The bridge's JSON shapes |
| `EnvSpecError` | `Io`, `Json`, `Bridge`, `Domain` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-env-spec
pnpm --filter @opensesame/env-spec-bridge test
```

`bridge_roundtrip_fixture` parses
[`tests/fixtures/demo.env.schema`](../../tests/fixtures/demo.env.schema)
through the real bridge; it prints a skip line when `node` is missing or the
bridge's dependencies are not installed.

## Related

- [ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md) — env-spec
  delivery modes
- [`.env.schema`](../../.env.schema) — the repository's own schema
