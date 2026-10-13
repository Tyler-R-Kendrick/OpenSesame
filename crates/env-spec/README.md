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
- The bridge is started by `node_command` and nothing else: `node` is found
  among the `PATH` entries that are absolute, exist, are owned by root or the
  caller, cannot be written by others, and are group-writable only by root's
  group or one of the caller's own (`root:root 0775` and `user:user 0775` pass,
  `root:othergroup 0775` and `0777` do not; Windows: absolute, existing, not the
  current directory), and the `node` itself must be owned by root or the caller
  and not world-writable. So an empty or relative entry cannot run a `node`
  planted in the working directory, and it is run by its absolute path. Its
  environment is built, not inherited: `PATH` (those entries), `HOME`,
  `TMPDIR`, `LANG`, the `LC_*` locale variables and, on Windows, `SystemRoot`,
  `PATHEXT` and `COMSPEC`. The store passphrase and every other `OPENSESAME_*`
  variable, `NODE_OPTIONS`, `NODE_PATH`, tokens and proxy settings never reach
  it, so an inherited `--import` or `--require` cannot load other code into the
  process that reads configuration either. With no such `node` the error says
  so and names every entry or file it skipped and why ("writable by others",
  "group-writable by group 1234 which is not one of yours", "owned by uid
  1001"); the inherited `PATH` is not a fallback.
- Placeholder suffixes are random per projection.

## Surface

| Item | What it is |
|---|---|
| `parse_schema_file(path)` | Runs `node packages/env-spec-bridge/bin/opensesame-env-parse.mjs <path>` under `node_command`; `OPENSESAME_ENV_PARSE` overrides the script path |
| `node_command()` | The one way to start Node here: the trusted `node` and the minimal environment above, ready for the script's arguments |
| `parse_schema_json(json)` | Parses bridge output already in hand |
| `schema_summary(doc)` | Per item: key, sensitive / required / public flags, resolver name, whether a value is present — never the value |
| `resolve_for_delivery(doc, policy, agent)` | `Vec<ResolvedEnvEntry>` with delivery mode, connection ref, projection, `omitted` and `warning` |
| `EnvSpecDocument`, `EnvSpecItem`, `EnvDecorator`, `EnvResolver`, `EnvResolverArg` | The bridge's JSON shapes |
| `EnvSpecError` | `Io`, `Json`, `Bridge`, `Domain`, `Scope`, `Node` (no usable `node`) |
| `web_login`, `WebLogin`, `LOGIN_RESOLVER` | The `opensesameLogin(...)` resolver: a sealed-store path and one form submission, never the password; the entry resolves omitted and only the optional `surrogate-proxy` plugin delivers anything for it (ADR 0150 §6.3) |
| `is_bounded_prefix`, `is_http_method`; `ResolvedEnvEntry::path_prefixes` | The `paths=` and `methods=` a connection entry may declare to bound its surrogate (ADR 0150 §8) |

## Develop

```bash
cargo +1.88.0 test -p opensesame-env-spec
pnpm --filter @opensesame/env-spec-bridge test
```

`tests/bridge_isolation.rs` starts this test binary again as the process that
parses, with a planted `node` in its working directory, an empty and a relative
`PATH` entry, a directory others can write, a `0775` directory of its own group
(trusted), and a spread of dummy secrets in its environment, and reads what the
`node` it ran was handed. `src/node_bridge/trust/tests.rs` is the table of
owner, group and mode combinations the trust rule decides.

`bridge_roundtrip_fixture` parses
[`tests/fixtures/demo.env.schema`](../../tests/fixtures/demo.env.schema)
through the real bridge; it prints a skip line when `node` is missing or the
bridge's dependencies are not installed.

## Related

- [ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md) — env-spec
  delivery modes
- [`.env.schema`](../../.env.schema) — the repository's own schema
