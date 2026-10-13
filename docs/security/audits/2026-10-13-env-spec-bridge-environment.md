# The env-spec bridge inherited the store passphrase and a PATH-resolved node

## Scope

- `crates/env-spec`: `parse_schema_file`, which `opensesame dev check|resolve|run`
  calls to read a `.env.schema` through the `@env-spec/parser` Node bridge.
- Found by an independent review of a tool that launches
  `opensesame dev --agent --schema <file> run -- <cmd>`.

## Invariant

`dev run --agent` keeps the store passphrase (`OPENSESAME_STORE_PASSWORD`) from
the child it runs (`apps/cli/src/dev_run.rs`; the run is
[ADR 0150](../../adr/0150-surrogate-credentials-at-the-last-hop.md) §6). The
process that reads the schema is not that child, but it holds the same secrets,
and nothing it starts should hold them either.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The bridge ran as a bare `Command::new("node")` with the whole inherited environment. The passphrase was stripped only for the final child, so the bridge and everything Node starts (`NODE_PATH`, loader variables, `npm_config_*`) received it, with every other `OPENSESAME_*` variable, tokens and proxy URLs with credentials. `node` was resolved through the inherited `PATH`, where an empty or relative entry means the working directory: a `node` planted in the directory the command ran in, or behind a trailing `:`, ran with all of it. The review demonstrated this with a stub that wrote its environment to a file. | `node_command` is the one way the crate starts Node. It searches only `PATH` entries that are absolute, exist and cannot be written by group or others (Windows: absolute, existing, not the current directory), starts the `node` it finds by absolute path, and builds the environment instead of inheriting it: `PATH` (those entries), `HOME`, `TMPDIR`, `LANG`, the `LC_*` variables and, on Windows, `SystemRoot`, `PATHEXT`, `COMSPEC`. With no such `node` the run stops with `no usable node` and names every entry it skipped; the inherited `PATH` is never a fallback. |

## Tests

- `crates/env-spec/tests/bridge_isolation.rs` starts the test binary again as the
  process that parses and reads what the `node` it ran was handed. Before the
  fix, a `node` planted behind an empty entry, `.`, a relative entry and a
  world-writable directory each ran and recorded
  `OPENSESAME_STORE_PASSWORD=<passphrase>`, the bridge environment held every
  variable the process had, and a `PATH` with no trusted `node` still ran the
  planted one. After it, none runs, the bridge environment is exactly
  `HOME`, `LANG`, `LC_ALL`, `PATH`, `TMPDIR`, and a real Node still parses under
  it.
- `apps/cli/tests/dev_run_bridge_env.rs` does the same through the real
  `opensesame` binary, and pins that the final child still receives its whole
  environment and the schema's entries (an agent child loses only
  `OPENSESAME_STORE_PASSWORD`, as before). Those child assertions pass on the
  code before the fix too.
- `crates/env-spec/src/node_bridge/tests.rs` pins the search (order, each
  skipped reason, directory modes) and the allowlist, including the Windows
  rules.

## Other spawns of Node and interpreters

- The TypeScript spawns of Node a search of `packages`, `apps`, `tools` and `scripts`
  found use `process.execPath`, not `PATH`.
- Rust test code spawns `node` through `PATH` in `crates/proof`, `crates/bitwarden-server`
  and `tests/mtls-interop`. They hold no secret and run in test processes only.
- Rust production spawns of `git`, `gpg`, `gh`, `openssl`, `sops` and the clipboard and
  browser openers are not interpreters or bridges, resolve through `PATH` and
  inherit the environment. They need an environment that includes their own
  configuration (`GIT_*`, `GH_TOKEN`, `SSH_AUTH_SOCK`, `HOME`), so they cannot take
  this allowlist, and are not changed here.

## Not fixed

- A `node` in a `PATH` directory only its owner can write is trusted; so is the
  bridge script (`OPENSESAME_ENV_PARSE` or the repository's own). A caller who
  controls either already controls the process.
- A directory that is group-writable because of a user-private-group `umask 002`
  (some `nvm` and `volta` layouts) is skipped like any other; the error names it.
- The Windows rules are exercised by unit tests of the decision functions, not by
  a run on Windows.
- The PATH-resolved spawns above are a related class (`git` in `sealed-store`
  runs with the passphrase in its environment) and are left for a follow-up.
