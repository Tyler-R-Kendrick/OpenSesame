# Fixed-name programs ran from PATH with the whole environment

## Scope

- Production Rust code that starts an external program by a fixed name: `git`,
  `gpg`, `gh`, `vercel`, SOPS, `age-plugin-yubikey`, `ps`, `tailscale`,
  `hostname`, `kill`, `taskkill`, the browser openers, the daemon's discovery
  CLIs and invoke-through token source, `tomb`, the enrollment prompts and
  `opensesame-id`.
- The follow-up the [2026-10-13 audit](2026-10-13-env-spec-bridge-environment.md)
  left under Not fixed, which gave `node` for the env-spec bridge the rule
  below.

## Invariant

`opensesame` (the CLI, the Host, the daemon) may hold the sealed store's
password, `OPENSESAME_CONNECTION_KEY`, provider tokens, a GitHub App's private
key and cloud credentials. A program it starts by name must be the file the
operator meant, and must receive only what it needs to do its job.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `git` (`crates/sealed-store`: every store commit, `pass git`, history, restore and the backup push), `gpg` (`.gpg` entries), `gh auth token` (the backup push credential) and the connect doctor's `gh`/`vercel`, `age-plugin-yubikey`, `ps`, `tailscale`, `hostname`, `kill`, `taskkill`, `xdg-open`, `open` and `explorer.exe` were started as `Command::new("<name>")`. The name resolved through the inherited `PATH`, where an empty or relative entry means the working directory and a world-writable directory can hold anyone's file, and the child inherited the whole environment: every `OPENSESAME_*` secret, `GITHUB_APP_PRIVATE_KEY`, `AWS_*`, and the parent's `GIT_DIR`, `GIT_EXEC_PATH` and `GIT_CONFIG_*`, which redirect git to another repository, other programs or other configuration. A `git` planted in a 0777 directory ahead of `/usr/bin` ran, and a stub `git` recorded `OPENSESAME_CONNECTION_KEY`. | Every such spawn goes through [`opensesame-trusted-exec`](../../../crates/trusted-exec): the program's override variable names the exact file, or the trusted `PATH` search finds it, and the child starts from an empty environment that the code adds to beside the spawn, with a reason for each variable. |
| Low | `OPENSESAME_SOPS_BIN` accepted any regular file, executable or not, and `OPENSESAME_AGE_PLUGIN_YUBIKEY` that could not be used fell back to a `PATH` search. | Both follow the shared override rule: after symlinks a regular file with an execute bit, and a value that cannot be used is reported, never replaced by a search. |

## The rule

One crate, std only plus `libc` on Unix (`geteuid`, `getegid`, `getgroups`),
the rule the env-spec bridge already used for `node`:

- **Override first.** `OPENSESAME_<PROGRAM>` names the exact file. It must be
  absolute, exist, and after symlinks be a regular file with an execute bit. It
  skips the ownership checks, because the operator chose that file; anyone who
  can set the process's environment could already point it at any program. A
  value that is empty, relative, missing, not a regular file or not executable
  is an error that names the variable. It never becomes a `PATH` search, and the
  variable is not passed to the child.
- **Otherwise a trusted `PATH` entry.** Searched only when absolute, existing,
  a directory, owned by root or the effective user, not writable by others, and,
  when group-writable, owned by root's group or one of the caller's. The file
  found must be owned by root or the caller and not world-writable. On Windows:
  absolute, existing and not the current directory. Empty and relative entries
  are never searched and the inherited `PATH` is never a fallback: the error
  names every skipped entry and file and why.
- **An environment built, not inherited.** `env_clear()`, then `PATH` reduced to
  the trusted entries, `HOME`, `TMPDIR`, `LANG` and the thirteen `LC_*`
  variables (on Windows also `SystemRoot`, `PATHEXT`, `COMSPEC`, `TEMP`, `TMP`,
  `USERPROFILE`), then the program's own list, then what the code itself sets.

## Programs

| Program | Where it is started | Override | Given beyond the common set |
| --- | --- | --- | --- |
| `git` | `crates/sealed-store/src/git_exec.rs` (used by `git.rs`, `history.rs`) | `OPENSESAME_GIT` | `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` (credential cache socket), `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (a libsecret credential helper), `GIT_SSL_CAINFO`, the proxy variables in both cases (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`), `SSL_CERT_FILE`, `SSL_CERT_DIR`. Set by the code: `OPENSESAME_GIT_TOKEN` for a token push, read by the push's own credential helper. Not passed: `GIT_DIR`, `GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS` (the code sets none of them; an ssh command belongs in `core.sshCommand`). |
| `gpg` | `crates/sealed-store/src/gpg.rs` | `OPENSESAME_GPG` | `GNUPGHOME`, `GPG_AGENT_INFO`, and what gpg forwards to gpg-agent for pinentry: `GPG_TTY`, `TERM`, `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`. |
| `gh` | `apps/cli/src/github.rs` (`gh auth token`; the connect doctor's `gh auth status`) | `OPENSESAME_GH` | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (gh keeps its token in the keyring), the proxy and CA variables. Not passed: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH`. |
| `vercel` | `apps/cli/src/connect/local_cli.rs` (the doctor's `vercel whoami`) | none | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, the proxy and CA variables. |
| SOPS | `crates/sealed-store/src/sops_interop.rs` | `OPENSESAME_SOPS_BIN`, the only way to find it (no `PATH` search) | Nothing inherited, as before: `LANG=C`, `LC_ALL=C`, `PATH` = the binary's own directory, `SOPS_AGE_KEY_FILE` emptied. `--age` encryption and decryption from stdin reach no network, so no proxy or CA variables. |
| `age-plugin-yubikey` | `crates/sealed-store/src/piv_age.rs` (`--help` probe) | `OPENSESAME_AGE_PLUGIN_YUBIKEY` | Nothing: the plugin reaches the card through pcscd's socket. |
| `ps` | `crates/cli-app-integration/src/terminal_session.rs` (macOS session id) | `OPENSESAME_PS` | Nothing: it reads the process table. |
| `tailscale`, `tailscale.exe` | `crates/daemon/src/tailscale/exec.rs` | `OPENSESAME_TAILSCALE` (new; the daemon had no setting for the CLI) | `WSL_INTEROP`, `WSL_DISTRO_NAME`, `WSLENV`, for a Windows CLI started from WSL. When no trusted entry holds it, the fixed Windows install paths under `/mnt/c` are tried as before: WSL mounts Windows drives writable by everyone, so their `PATH` entries never pass. Windows' `curl.exe` (a fixed path) gets the same environment. |
| `hostname`, `kill`, `taskkill` | `crates/daemon/src/tailscale.rs`; `kill` also in `apps/cli/src/daemon_cmd.rs` (`daemon stop`) | none | Nothing. |
| `xdg-open`, `open`, `explorer.exe` | `apps/cli/src/connect/browser.rs` | none | `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_*`, `BROWSER`; on Windows `APPDATA` and `LOCALAPPDATA`. |
| `node` | `crates/env-spec/src/node_bridge.rs` | `OPENSESAME_NODE` | As in the 2026-10-13 audit, now resolved by the shared crate: exactly `PATH`, `HOME`, `TMPDIR`, `LANG`, the `LC_*` variables (on Windows `SystemRoot`, `PATHEXT`, `COMSPEC`). |
| CLI probes and the invoke-through token source (`gh`, `glab`, `aws`, `gcloud`, `op`, `kubectl`, `pass`, …) | `crates/daemon/src/runner/programs.rs` (used by `ScrubbedCommandRunner` in `runner.rs`, and by presence in `cli_probe.rs`) | `OPENSESAME_GH` for `gh`; none for the others | Found over the snapshot the runner holds, so a snapshot without `PATH` runs nothing and a CLI in a directory anyone can write is neither offered nor run. Every CLI: `USER`, `LOGNAME`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` (the keychain), as ADR 0048's allowlist already gave. Each adds where its own configuration is: `gh` `GH_CONFIG_DIR`, `GH_HOST`, `XDG_CONFIG_HOME`; `glab` `GLAB_CONFIG_DIR`, `XDG_CONFIG_HOME`; `aws` `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE` (never the keys); `gcloud` `CLOUDSDK_CONFIG`; `op` `OP_CONFIG_DIR`, `XDG_CONFIG_HOME`; `kubectl` `KUBECONFIG`. `pass` still gets no `PASSWORD_STORE_DIR`, as its probe documents. |
| `tomb` | `apps/cli/src/store/tomb_exec.rs` (`opensesame tomb open` and `close`) | `OPENSESAME_TOMB` | `GNUPGHOME`, `GPG_AGENT_INFO`, `GPG_TTY`, `TERM`, `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` (the gpg-sealed key's pinentry), `SUDO_ASKPASS` (mounting without a terminal). |
| `osascript`, `systemd-ask-password`, `zenity`, `powershell.exe` | `apps/cli/src/enroll_entry.rs` (the root-trust enrollment prompt) | none | `zenity`: `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`; `powershell.exe`: `APPDATA`, `LOCALAPPDATA`; the others nothing. No trusted prompt is the same as no prompt: enrollment is refused. |
| `opensesame-id` | `apps/cli/src/vault_file.rs` (the `opensesame vault` item commands: `new`, `list`, `import`, `export`, `set`, `copy`, `share`) | `OPENSESAME_ID_BIN`, now held to the override rule (an absolute executable file; a bare name is refused) | `OPENSESAME_STATE_DIR` (its vault), `TERM` (its password prompt), `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR` (`vault copy`'s clipboard tool). Not `NODE_OPTIONS` or any other `NODE_*`, nor the store password. |

`openssl` has no production spawn. Its three `Command::new("openssl")` calls
(`apps/cli/src/github.rs`, `crates/connection-broker/src/installation.rs`,
`crates/gateway/src/backup.rs`) are inside `#[cfg(test)]`, where they mint a
throwaway RSA key, so there is no `OPENSESAME_OPENSSL`.

## Tests

Each program family has a test that fails on the code before the change:

- `crates/sealed-store/tests/spawn_trust.rs` points the test process's own
  environment at a planted `PATH` (a 0777 directory whose stub writes a marker,
  ahead of a private directory whose stub records its environment and
  arguments) and calls the crate's public functions. Before the change:
  `push_backup`, `git_passthrough` and `remote_url` ran the planted `git` ("the
  planted git ran"); with nothing planted, `OPENSESAME_CONNECTION_KEY` reached
  git ("OPENSESAME_CONNECTION_KEY reached git"); `decrypt_gpg_file` ran the
  planted `gpg`; discovery ran the planted `age-plugin-yubikey`; and a
  non-executable `OPENSESAME_SOPS_BIN` was accepted. After it the trusted stub
  runs, the push still carries its token and the operator's `HTTPS_PROXY`, and
  `GIT_SSH_COMMAND`, the parent's `GIT_*` and the dummy secret never arrive.
- `crates/trusted-exec` holds the trust table moved from env-spec, the override
  table for any variable, the allowance helper's name, prefix and Windows case
  rules, and runs planted and override stubs named `git`, `gpg`, `gh` and
  `openssl`. Its `testkit` feature is the planted fixture the other crates use.
- `git_exec`, `gpg`, `github::gh_in`, `connect/local_cli`, `connect/browser`,
  `terminal_session::ps_in` and `tailscale/exec` each pin their own allowance
  and override through that fixture. Before the change, the daemon's
  `resolve_tailscale_bin` returned the planted `tailscale` from a 0777
  directory ahead of the trusted one (shown with a test against the old file,
  not committed).
- `crates/daemon/src/runner/tests.rs` runs the discovery runner and the token
  source over a planted snapshot, and `cli_probe.rs` checks presence. Before
  the change: a planted `gh` and `kubectl` were offered ("planted CLIs were
  offered: [... github ... High ...]"), the token source captured the planted
  `gh`'s empty output instead of the trusted one's token ("gh printed no
  credential"), a CLI was handed none of its own configuration and
  `OPENSESAME_GH` was ignored ("the planted gh ran"), and a snapshot with no
  `PATH` still ran `sh`. The existing runner tests now give their snapshot
  `PATH=/usr/bin:/bin`.
- `tomb`, the enrollment prompts and `opensesame-id` were each shown with a
  test against the old file, not committed: "which_tomb took the planted
  tomb", "the planted zenity ran", "the planted opensesame-id ran". The
  committed tests use the fixture through `tomb_exec`, `prompt_in` and
  `id_cli_in`.
- env-spec keeps all of its tests and messages.

## Not changed here

Programs a person or operator names on purpose keep their own rules: the
command `dev run` starts, connector-host executable plans, the password-agent
programs its policy names, the surrogate-proxy plugin's source, the
`local_authority` executable and `opensesame` re-running its own
`current_exe()`.

## Limits

- Linux only. The Windows rules are unit tests of the decision functions; the
  macOS `ps` call is compiled only on macOS (its builder and test run here).
  WSL interop with the cleared environment was not run.
- The credential helper, pinentry and keyring variables are passed by reading
  how those programs find their state; a libsecret helper, a graphical pinentry
  and gh's keyring were not exercised. The same holds for each discovery CLI's
  configuration variables (`GLAB_CONFIG_DIR`, `CLOUDSDK_CONFIG`,
  `OP_CONFIG_DIR`, ...): the real CLIs were not run.
- `OPENSESAME_ID_BIN` used to accept any value, including a bare name searched
  on `PATH`; it now takes an absolute executable file only.
- An operator who relied on `GIT_SSH_COMMAND`, `GIT_SSH` or `GIT_ASKPASS` for the
  store's remote now sets `core.sshCommand` or a credential helper in git's own
  configuration instead.
- A member of a group the caller belongs to can replace a program in a
  directory that group can write; the rule assumes the caller's own groups are
  the caller's, as the 2026-10-13 audit says.
