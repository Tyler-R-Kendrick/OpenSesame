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
| High | The bridge ran as a bare `Command::new("node")` with the whole inherited environment. The passphrase was stripped only for the final child, so the bridge and everything Node starts (`NODE_PATH`, loader variables, `npm_config_*`) received it, with every other `OPENSESAME_*` variable, tokens and proxy URLs with credentials. `node` was resolved through the inherited `PATH`, where an empty or relative entry means the working directory: a `node` planted in the directory the command ran in, or behind a trailing `:`, ran with all of it. The review demonstrated this with a stub that wrote its environment to a file. | `node_command` is the one way the crate starts Node. It searches only `PATH` entries that are absolute, exist, are directories, are owned by root or the effective user, cannot be written by others, and, when group-writable, belong to root's group (gid 0) or one of the caller's own (`getegid`, `getgroups`). Windows: absolute, existing, not the current directory. It starts the `node` it finds by absolute path, and requires that file to be owned by root or the caller and not world-writable. It builds the environment instead of inheriting it: `PATH` (those entries), `HOME`, `TMPDIR`, `LANG`, the `LC_*` variables and, on Windows, `SystemRoot`, `PATHEXT`, `COMSPEC`. An operator can name the exact file with `OPENSESAME_NODE=<absolute path>`: it is consulted first, must exist and (after symlinks) be a regular file with an execute bit, and is exempt from the directory and file ownership and mode checks, because the operator chose that file (the same trust as `OPENSESAME_ENV_PARSE`, the script it runs); an empty, relative, missing, non-file or non-executable value is an error that names the variable and never becomes the `PATH` search; the variable is not passed on to the bridge. With no such `node` the run stops with `no usable node` and names every entry or file it skipped with the exact reason (`writable by others`, `group-writable by group 1234 which is not one of yours`, `owned by uid 1001`); the inherited `PATH` is never a fallback. |

The trust rule first skipped every directory that group or others could write.
That refused real layouts: `nvm`, `volta` and Homebrew create `user:user 0775`
trees under `umask 002`, and some systems keep root-owned `0775` directories. The
rule above takes those and still refuses what a planted `node` needs: a directory
another user owns, anyone can write, or a group the caller is not in can write.
It does not take a world-writable directory; see Not fixed.

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
- `crates/env-spec/src/node_bridge/trust/tests.rs` is the table of owner, group and
  mode combinations the rule decides, with injected `stat` results: `root:root 0755`,
  `root:root 0775` and `user:user 0775` (searched); `root:othergroup 0775`, `0777`,
  `0757`, sticky `1777` and a directory another uid owns (refused); and the same for
  the `node` file. `src/node_bridge/tests.rs` pins the search (order, each skipped
  reason, real directory modes, the real `stat` reaching the decision) and the
  allowlist, including the Windows rules. `bridge_isolation.rs` and
  `dev_run_bridge_env.rs` each run a `0775` directory of the caller's own group,
  the CI layout, and it supplies the node. The same two files pin
  `OPENSESAME_NODE` through the real binary and the test process: it wins over a
  trusted `PATH` node, a 0777 file in a 0777 directory is used, an empty,
  relative, missing, directory and non-executable value is refused naming the
  variable with no `PATH` fallback, and the variable never reaches the node.

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
- A `node` in a directory root or the caller owns, that only root's group or the
  caller's groups can write, is trusted. A member of such a group can replace it;
  the rule assumes the caller's own groups are the caller's.
- A directory anyone can write is still refused on the `PATH` search, even when
  absolute and owned by root, and so is a world-writable `node`. Hosted CI images
  set both on purpose (`actions/runner-images`, `install-nodejs.sh`:
  `chmod -R 777 /usr/local/bin`). There the operator names the file with
  `OPENSESAME_NODE`, or puts a trusted Node (for example the one
  `actions/setup-node` installs) first on `PATH`. The CI Rust job sets
  `OPENSESAME_NODE` to the runner's `node`, and the two tests that would
  otherwise skip when no node can be resolved fail instead when `CI` is set.
- `OPENSESAME_NODE` is trusted as named. Anyone who can set the environment of
  `opensesame` can already point it at any program through
  `OPENSESAME_ENV_PARSE`; the variable adds no new reach, and it replaces the
  checks that a `PATH` search needs because nobody searched.
- The Windows rules are exercised by unit tests of the decision functions, not by
  a run on Windows.
- The PATH-resolved spawns above are a related class (`git` in `sealed-store`
  runs with the passphrase in its environment) and are left for a follow-up.
