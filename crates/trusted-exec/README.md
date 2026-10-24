# opensesame-trusted-exec

Which file a fixed program name starts, and what that program is given
([audit](../../docs/security/audits/2026-10-17-external-program-spawns.md),
[ADR 0006](../../docs/adr/0006-env-spec-delivery-modes.md)).

`opensesame` starts `git`, `gpg`, `gh`, `node`, `tailscale`, `age-plugin-yubikey`,
`ps`, `tomb`, `opensesame-id`, the daemon's discovery CLIs, the enrollment
prompt and a browser opener by name, from a process that may hold the sealed
store's password, the Host's connection key and provider tokens. Every such
spawn goes through this crate:

- **Which file.** A program's override variable (`OPENSESAME_GIT`,
  `OPENSESAME_NODE`, ...) names the exact file: absolute, existing, and after
  symlinks a regular file with an execute bit. It is consulted first, skips the
  ownership checks, and a value that cannot be used is an error naming the
  variable. Otherwise only `PATH` entries that are absolute, exist, are not the
  current directory, are owned by root or the caller, are not writable by others,
  and are group-writable only by root's group or one of the caller's are
  searched; the file must be owned by root or the caller and not world-writable.
  Owning the current directory does not vouch for what is in it (a repository
  just cloned is yours, but its author chose its files), so it is skipped however
  `PATH` names it: compared by device and inode on Unix, so a link, a trailing
  slash or `/./` is the same directory, and a current directory that cannot be
  read leaves every entry untrusted. Empty and relative entries are never
  searched, and the inherited `PATH` is never a fallback: the error names every
  skipped entry and why.
- **What it sees.** `command_in` clears the environment and sets `PATH` to the
  trusted entries plus `COMMON` (`HOME`, `TMPDIR`, `LANG`, the thirteen `LC_*`;
  on Windows `SystemRoot`, `PATHEXT`, `COMSPEC`, `TEMP`, `TMP`, `USERPROFILE`).
  The code that starts the program adds, beside the spawn, only what that
  program needs (`pass_in` with names or prefixes, `PROXY`, `CA_BUNDLE`), then
  what it sets itself.

Dependencies: `std`, and `libc` on Unix for `geteuid`, `getegid` and `getgroups`.

## Surface

| Item | What it is |
|---|---|
| `resolve(program, var)`, `resolve_on_path(program)`, `resolve_in` | The file to run, or a `ResolveError` (`NotFound`, `Override`) |
| `command(program, var)`, `command_on_path(program)`, `command_in` | A `Command` for that file with the built environment |
| `pass`, `pass_in`, `Pass`, `COMMON`, `PROXY`, `CA_BUNDLE`, `LOCALE` | The allowance a spawn adds to |
| `named(var, value)` | The override rule on its own (`OPENSESAME_SOPS_BIN`, which has no `PATH` search) |
| `search`, `find`, `Lookup`, `Platform`, `trust` | The pieces, for a caller with its own environment rule (env-spec's bridge) |
| `testkit::Fixture` (feature `testkit`) | A planted `PATH` for other crates' tests: a stub that must never run, a trusted stub that records what it was given, and a hostile parent environment |

## Develop

```bash
cargo +1.88.0 test -p opensesame-trusted-exec
```

`src/trust/tests.rs` is the table of owner, group and mode combinations the
rule decides; `src/tests.rs` runs real stubs from a planted `PATH`.
