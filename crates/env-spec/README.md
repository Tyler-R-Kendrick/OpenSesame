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
- The bridge is started by `node_command` and nothing else. If the operator
  set `OPENSESAME_NODE` to an absolute path, that file is the `node`: it is
  consulted first, it must exist and (after symlinks) be a regular file with an
  execute bit, and it is exempt from the directory and file ownership and mode
  checks below, because the operator named the exact file (the same trust as
  `OPENSESAME_ENV_PARSE`, the script it runs). An empty, relative, missing,
  non-file or non-executable value is an error that names the variable
  (`EnvSpecError::NodeOverride`); it never falls back to `PATH`, and the
  variable is not passed on to the bridge. Without it, `node` is found
  among the `PATH` entries that are absolute, exist, are owned by root or the
  caller, cannot be written by others, and are group-writable only by root's
  group or one of the caller's own (`root:root 0775` and `user:user 0775` pass,
  `root:othergroup 0775` and `0777` do not; Windows: absolute, existing, not the
  current directory), and the `node` itself (after symlinks) is held to the same
  rule: owned by root or the caller, not writable by others, group-writable only
  by root's group or one of the caller's. So an empty or relative entry cannot run a `node`
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
- The script `node` runs is `OPENSESAME_ENV_PARSE` when set, used as named;
  else `opensesame-env-parse.mjs` in the directory of the running executable
  after symlinks, where a [release kit](../../docs/operators/release-kit.md)
  ships the bundled bridge; else the checkout's
  `packages/env-spec-bridge/bin/opensesame-env-parse.mjs`. The file beside the
  executable must pass the same rule as a `node` on `PATH`: the directory it is
  named in, the one it resolves into and the file itself owned by root or the
  caller, not writable by others and group-writable only by root's group or one
  of the caller's. A file there that fails, a link to nothing or a directory of
  that name is an error that says which path and why
  (`EnvSpecError::BridgeScript`), never a fall-through to the checkout's copy.
  With none beside the executable, no override and no checkout copy (a release
  binary run on its own, which still names the runner it was built on), the
  error says where it looked. The check is by path and covers no directory above
  the two it reads; on Windows a bridge is only checked to be a regular file.
- Placeholder suffixes are random per projection.

## Surface

| Item | What it is |
|---|---|
| `parse_schema_file(path)` | Runs the bridge (`OPENSESAME_ENV_PARSE`, else the trusted `opensesame-env-parse.mjs` beside the executable, else the checkout's) under `node_command` |
| `node_command()` | The one way to start Node here: `OPENSESAME_NODE`, else the trusted `node` on `PATH`, and the minimal environment above, ready for the script's arguments |
| `parse_schema_json(json)` | Parses bridge output already in hand |
| `schema_summary(doc)` | Per item: key, sensitive / required / public flags, resolver name, whether a value is present — never the value |
| `resolve_for_delivery(doc, policy, agent)` | `Vec<ResolvedEnvEntry>` with delivery mode, connection ref, projection, `omitted` and `warning` |
| `EnvSpecDocument`, `EnvSpecItem`, `EnvDecorator`, `EnvResolver`, `EnvResolverArg` | The bridge's JSON shapes |
| `EnvSpecError` | `Io`, `Json`, `Bridge`, `Domain`, `Scope`, `Node` (no usable `node` on `PATH`), `NodeOverride` (`OPENSESAME_NODE` cannot be used), `BridgeScript` (the bridge beside the executable may not be run, or there is none to run) |
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
`tests/bridge_beside_binary.rs` copies the test binary into a kit directory
beside a bridge and runs the copy, so `current_exe()` is the copy: a trusted
bridge there is the one `node` is handed, a world-writable one is refused with
the reason, `OPENSESAME_ENV_PARSE` still wins, and with none the checkout's copy
runs. `src/node_bridge/script/tests.rs` covers the directory, symlink and
resolved-executable cases.

`bridge_roundtrip_fixture` parses
[`tests/fixtures/demo.env.schema`](../../tests/fixtures/demo.env.schema)
through the real bridge; locally it prints a skip line when no usable `node`
resolves or the bridge's dependencies are not installed. With `CI` set either is
a failure: the Rust job names its `node` with `OPENSESAME_NODE` and installs
`@env-spec/parser` (`pnpm install --frozen-lockfile --ignore-scripts --filter
"@opensesame/env-spec-bridge..."`), so the round trip runs there.

## Related

- [ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md) — env-spec
  delivery modes
- [`.env.schema`](../../.env.schema) — the repository's own schema
