# Fixed-name programs ran from PATH with the whole environment

## Scope

This audit is split across two pull requests that merge in order.

- **The first (#1471)** covers `git`, `gpg`, `gh` and the doctor's `vercel`,
  SOPS, `age-plugin-yubikey`, `ps`, `tailscale`, `hostname`, `kill`, `taskkill`
  and the browser openers, plus `node` for the env-spec bridge, which it moves
  onto the same rule. It is the follow-up the
  [2026-10-13 audit](2026-10-13-env-spec-bridge-environment.md) left under Not
  fixed.
- **The second (#1478)** covers the daemon's discovery runner and invoke-through
  token source, `tomb`, the enrollment prompts, `opensesame-id`, the
  connector-host provider CLIs, the surrogate-proxy plugin's token source, the
  password-agent helpers and the keepassxc bridge.

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
  found must meet the same rule: owned by root or the caller, not writable by
  others, and group-writable only by root's group or the caller's. On Windows:
  absolute, existing and not the current directory. Empty and relative entries
  are never searched and the inherited `PATH` is never a fallback: the error
  names every skipped entry and file and why, and the variable that would name
  the program instead.
- **Every directory above it too (Unix).** A directory only root or the caller
  can write is no protection if the directory that holds it is one anyone can
  write: its owner can rename the trusted one away between the check and the
  `exec`. So the rule also asks every directory above the `PATH` entry, and
  above the file, both where the path lexically goes (the directory a symlink
  sits in) and where it really goes (the directory a symlink points into). One
  that another user owns, anyone can write, or a group the caller is not in can
  write refuses the program, unless it is root's and sticky (`/tmp`,
  `/nix/store`), where only an entry's own owner can rename it. What runs is the
  file's real path, the one that was checked, started under the name it was
  found as (`argv[0]`), so a shim that behaves by its name (`volta`, `mise`,
  `snap`) still does.
- **An environment built, not inherited.** `env_clear()`, then `PATH` reduced to
  the trusted entries (none at all when there are none: an empty `PATH` means the
  working directory to `execvp`, `env` and every shell), `HOME`, `TMPDIR`,
  `LANG` and the thirteen `LC_*` variables (on Windows also `SystemRoot`,
  `PATHEXT`, `COMSPEC`, `TEMP`, `TMP`, `USERPROFILE`, and the folders programs
  keep their state in: `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `SystemDrive`,
  `windir`), then the program's own list, then what the code itself sets.

## Programs

| Program | Where it is started | Override | Given beyond the common set |
| --- | --- | --- | --- |
| `git` | `crates/sealed-store/src/git_exec.rs` (used by `git.rs`, `history.rs`) | `OPENSESAME_GIT` | `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` (credential cache socket), `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (a libsecret credential helper), `GIT_SSL_CAINFO`, the proxy variables in both cases (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`), `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NIX_SSL_CERT_FILE`. Set by the code: `OPENSESAME_GIT_TOKEN` for a token push, read by the push's own credential helper; the push first empties git's helper list (`-c credential.helper=`), so the person's own helpers (`store`, `libsecret`, a manager) are never asked for the credential and never told to remember it. Not passed: `GIT_DIR`, `GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS` (the code sets none of them; an ssh command belongs in `core.sshCommand`). |
| `gpg` | `crates/sealed-store/src/gpg.rs` | `OPENSESAME_GPG` | `GNUPGHOME`, `GPG_AGENT_INFO`, and what gpg forwards to gpg-agent for pinentry: `GPG_TTY`, `TERM`, `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`. |
| `gh` | `apps/cli/src/github.rs` (`gh auth token`; the connect doctor's `gh auth status`) | `OPENSESAME_GH` | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` (a GitHub Enterprise Server host named by `GH_HOST`), `GH_HOST`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (gh keeps its token in the keyring), the version-manager variables (below), the proxy and CA variables. Not passed: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH`. |
| `vercel` | `apps/cli/src/connect/local_cli.rs` (the doctor's `vercel whoami`) | none | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, the version-manager variables, the proxy and CA variables. |
| SOPS | `crates/sealed-store/src/sops_interop.rs` | `OPENSESAME_SOPS_BIN`, the only way to find it (no `PATH` search) | Nothing inherited, as before: `LANG=C`, `LC_ALL=C`, `PATH` = the binary's own directory, `SOPS_AGE_KEY_FILE` emptied. `--age` encryption and decryption from stdin reach no network, so no proxy or CA variables. |
| `age-plugin-yubikey` | `crates/sealed-store/src/piv_age.rs` (`--help` probe) | `OPENSESAME_AGE_PLUGIN_YUBIKEY` | Nothing: the plugin reaches the card through pcscd's socket. |
| `ps` | `crates/cli-app-integration/src/terminal_session.rs` (macOS session id) | `OPENSESAME_PS` | Nothing: it reads the process table. |
| `tailscale`, `tailscale.exe` | `crates/daemon/src/tailscale/exec.rs` | `OPENSESAME_TAILSCALE` (new; the daemon had no setting for the CLI) | `WSL_INTEROP`, `WSL_DISTRO_NAME`, `WSLENV`, for a Windows CLI started from WSL. When no trusted entry holds it, the fixed Windows install paths under `/mnt/c` are tried as before: WSL mounts Windows drives writable by everyone, so their `PATH` entries never pass. Windows' `curl.exe` (a fixed path) gets the same environment. |
| `hostname`, `kill`, `taskkill` | `crates/daemon/src/tailscale.rs`; `kill` also in `apps/cli/src/daemon_cmd.rs` (`daemon stop`) | none | Nothing. |
| `xdg-open`, `open`, `explorer.exe` | `apps/cli/src/connect/browser.rs` | none | `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_*`, `BROWSER`, and on WSL `WSL_INTEROP`, `WSL_DISTRO_NAME`, `WSLENV`. With no opener of its own, WSL opens the page with Windows' `explorer.exe` at its fixed path (`/mnt/c/Windows/explorer.exe`), as the Tailscale CLI does: WSL mounts Windows drives writable by everyone, so their `PATH` entries never pass. |
| `node` | `crates/env-spec/src/node_bridge.rs` | `OPENSESAME_NODE` | As in the 2026-10-13 audit, now resolved by the shared crate: exactly `PATH`, `HOME`, `TMPDIR`, `LANG`, the `LC_*` variables, the version-manager variables below (on Windows `SystemRoot`, `PATHEXT`, `COMSPEC`). |
| CLI probes and the invoke-through token source (`gh`, `glab`, `aws`, `gcloud`, `op`, `kubectl`, `pass`, …) | `crates/daemon/src/runner/programs.rs` (used by `ScrubbedCommandRunner` in `runner.rs`, and by presence in `cli_probe.rs`) | `OPENSESAME_GH` for `gh`; none for the others | Found over the snapshot the runner holds (on Windows its `Path` is the `PATH`, as that platform spells it), so a snapshot without `PATH` runs nothing and a CLI in a directory anyone can write is neither offered nor run. Every CLI: `USER`, `LOGNAME`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` (the keychain), as ADR 0048's allowlist already gave. Each adds where its own configuration is: `gh` `GH_CONFIG_DIR`, `GH_HOST`, `XDG_CONFIG_HOME`; `glab` `GLAB_CONFIG_DIR`, `XDG_CONFIG_HOME`; `aws` `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE` (never the keys); `gcloud` `CLOUDSDK_CONFIG`; `op` `OP_CONFIG_DIR`, `XDG_CONFIG_HOME`; `kubectl` `KUBECONFIG`. `pass` still gets no `PASSWORD_STORE_DIR`, as its probe documents. |
| `tomb` | `apps/cli/src/store/tomb_exec.rs` (`opensesame tomb open` and `close`) | `OPENSESAME_TOMB` | `GNUPGHOME`, `GPG_AGENT_INFO`, `GPG_TTY`, `TERM`, `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` (the gpg-sealed key's pinentry), `SUDO_ASKPASS` (mounting without a terminal). |
| `osascript`, `systemd-ask-password`, `zenity`, `powershell.exe` | `apps/cli/src/enroll_entry.rs` (the root-trust enrollment prompt) | none | `zenity`: `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`; `powershell.exe`: `APPDATA`, `LOCALAPPDATA`; the others nothing. No trusted prompt is the same as no prompt: enrollment is refused. |
| `opensesame-id` | `apps/cli/src/vault_file.rs` (the `opensesame vault` item commands: `new`, `list`, `import`, `export`, `set`, `copy`, `share`) | `OPENSESAME_ID_BIN`, now held to the override rule (an absolute executable file; a bare name is refused) | `OPENSESAME_STATE_DIR` (its vault), `TERM` (its password prompt), `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR` (`vault copy`'s clipboard tool). Not `NODE_OPTIONS` or any other `NODE_*`, nor the store password. It is a `#!/usr/bin/env node` script and its child sees only trusted `PATH` entries, so a `node` that only lives in a directory anyone can write is named with `OPENSESAME_NODE`: a private directory holding one link, `node`, goes first on the child's `PATH` until the command ends, and the open directory itself is never searched. |
| Provider CLIs: `age`, `aws`, `az`, `bao`, `bw`, `bws`, `doppler`, `foks`, `gcloud`, `gh`, `infisical`, `keepassxc-cli`, `op`, `pass`, `pass-cli`, `security`, `vault`, `ykman` | `crates/connector-host/src/providers.rs` and `providers/cli.rs`: the readiness and live probes, crypto plans and human plans, run by the Host's provider test route, the worker's health probe and the human CLI | `OPENSESAME_<NAME>_BIN` for each (`OPENSESAME_AWS_BIN`, `OPENSESAME_KEEPASSXC_CLI_BIN`, …); `gh` keeps `OPENSESAME_GH`, the variable the CLI already uses | The [provider CLI table](#provider-clis) below. Never any `OPENSESAME_*`. A catalog adapter or plan that names a CLI off the table fails a test. |
| `gh` (the surrogate-proxy plugin's token source) | `crates/surrogate-proxy/src/plugin/source.rs` | `OPENSESAME_GH` | `USER`, `LOGNAME`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `GH_CONFIG_DIR`, `GH_HOST`. Not `GH_TOKEN`: the output of `gh auth token` is the credential. |
| `op`, `secret-tool`, `osascript`, `powershell.exe`, `pbpaste`, `wl-paste`, `xclip` | `apps/cli/src/password_agent/io.rs` (`helper`) | `OPENSESAME_OP_BIN` for `op`; none for the others | `op`: the `OP_*` family (the service-account token is then set or removed by `credential::authenticate`, never inherited), the desktop and keyring variables, version-manager, proxy and CA variables. `secret-tool`: the desktop and keyring variables. `wl-paste`: `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE`. `xclip`: `DISPLAY`, `XAUTHORITY`. Never the store password or any `OPENSESAME_*`. |
| `op run -- …` | `apps/cli/src/password_agent/consume.rs` (`run_assignments`, `env run`) | `OPENSESAME_OP_BIN` | `op run` hosts a command of the person's own and hands it its environment, so it is started in the person's environment, less interpreter hooks (`NODE_OPTIONS`, `LD_PRELOAD`, …), as before. What changed is which `op` it is: the trusted file. |
| `opensesame-keepassxc-bridge` | `apps/cli/src/bridge/serve.rs` (`opensesame bridge keepassxc serve`) | `--bin <absolute path>` | The bridge is the sibling binary installed with this `opensesame`, started like `daemon start` starts `opensesame` itself, and it reads the store password from the environment this command was given. It is the file `--bin` names (an absolute executable file) or the one beside `current_exe()`. The bare-name fallback, which a `PATH` search answered, is gone. |

**Version managers.** `node`, `gh`, `vercel` and the tools a shim stands for
are often `volta`, `asdf` or `mise` shims, which need to be told where they
live: `VOLTA_HOME`, `ASDF_DATA_DIR`, `MISE_DATA_DIR` and `XDG_DATA_HOME` are
passed to those programs, and Nix's `NIX_SSL_CERT_FILE` is part of the CA group
every network-reaching program gets. A shim runs under the name it was found as,
not under the program it points to.

`openssl` has no production spawn. Its three `Command::new("openssl")` calls
(`apps/cli/src/github.rs`, `crates/connection-broker/src/installation.rs`,
`crates/gateway/src/backup.rs`) are inside `#[cfg(test)]`, where they mint a
throwaway RSA key, so there is no `OPENSESAME_OPENSSL`.

### Provider CLIs

Each is started by the file `OPENSESAME_<NAME>_BIN` names, or the trusted
`PATH` entry that holds it, with `PATH`, the common set and the version-manager
variables, plus these. The network CLIs also get the proxy and CA variables.
Credentials a CLI reads are passed on purpose: it is the connection's own CLI.
The lists come from each CLI's documented variables; the real CLIs were not run.

| CLI | Own variables |
| --- | --- |
| `age`, `keepassxc-cli`, `security` | none |
| `aws` | `AWS_*` (profile, region, endpoint and the key variables) |
| `az` | `AZURE_*`, `REQUESTS_CA_BUNDLE` |
| `bao` | `BAO_*`, `VAULT_*` |
| `bw` | `BW_*`, `BITWARDENCLI_APPDATA_DIR`, `NODE_EXTRA_CA_CERTS` (not `NODE_OPTIONS`) |
| `bws` | `BWS_*` |
| `doppler`, `foks`, `infisical` | `DOPPLER_*`, `FOKS_*`, `INFISICAL_*`, and the keyring variables (`XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`) |
| `gcloud` | `CLOUDSDK_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_QUOTA_PROJECT` |
| `gh` (the `github-oauth` lease, `gh auth token --hostname`) | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR` and the keyring variables; not `GITHUB_APP_*` |
| `op` | `OP_*` and the keyring variables |
| `pass` | `PASSWORD_STORE_*` and what gpg forwards for a pinentry (`GNUPGHOME`, `GPG_AGENT_INFO`, `GPG_TTY`, `TERM`, `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`) |
| `pass-cli` | `PROTON_PASS_*` and the keyring variables |
| `vault` | `VAULT_*` |
| `ykman` | `XDG_RUNTIME_DIR` (the smart-card daemon's socket) |

A `custom-command` connection names its own program, which is the person's
choice and runs as written by the name they gave (`HumanProviderPlan::Custom`).

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
  The review that followed the first version of this change found six more
  holes, each now a test that failed first: a program under a directory anyone
  can write was accepted and a swap after resolution ran ("the swapped-in git
  ran: PLANTED-SWAP"); a link into such a directory was accepted ("the
  swapped-in gpg ran: PLANTED-GPG"); a link ran under the link's path, not its
  target's; a file group-writable by a group the caller is not in was accepted
  (`root:othergroup 0775`, expected `GroupWritable(5000)`, got `None`); a child
  of a program found through its override with no trusted `PATH` got `PATH=`,
  which `env` reads as the working directory ("a node in the working directory
  ran"); the Windows environment lacked `APPDATA` and its siblings; and the
  refusal did not name the override variable.
- `git_exec`, `gpg`, `github::gh_in`, `connect/local_cli`, `connect/browser`,
  `terminal_session::ps_in` and `tailscale/exec` each pin their own allowance
  and override through that fixture. Also failing first: a push token was
  written to `~/.git-credentials` by a person's own `credential.helper=store`
  ("the push token was stored by the person's own helper"); a refused `gh`, the
  doctor's CLI and `ps` were silent; the SOPS refusal kept a fixed text that was
  also given for a non-executable file; `GH_ENTERPRISE_TOKEN` and a version
  manager's home did not reach `gh`; `daemon start` fell back to a bare
  `opensesame`; and WSL had no opener of its own once its `PATH` lost the
  `/mnt/c` entries. Before the change, the daemon's `resolve_tailscale_bin`
  returned the planted `tailscale` from a 0777 directory ahead of the trusted
  one (shown with a test against the old file, not committed).
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
- An independent review of that work found more spawns and two defects, each
  now a test run first against the old behaviour (the old call put back in
  place for the run, then taken out):
  - **Provider CLIs** (`providers/cli/tests.rs`, 11 tests): 8 failed. The old
    bare-name call ran the planted CLI from a directory anyone can write
    ("the planted vault ran", "the planted aws ran", "the planted age ran"),
    and a CLI the override variable named, or that was not found, came back as
    a successful run instead of an error naming the variable
    ("called `Result::unwrap_err()` on an `Ok` value"). The tests also pin that
    each CLI hears its own family (`VAULT_ADDR` reaches `vault`, never `bw`),
    that no catalog adapter and no plan names a CLI off the table (this found
    `gh`, for the `github-oauth` lease, which the first draft of the table
    lacked), and that a `custom-command` program is not on the table.
  - **The plugin's `gh auth token`** (`source/trusted_tests.rs`, 6 tests): 5
    failed, the first with "the planted gh ran".
  - **Password-agent helpers** (`io/trusted_tests.rs`, 8 tests): 7 failed, with
    "the planted op ran" and "the trusted stub recorded" (the planted helper ran
    instead, as the review's `r6` showed with a copy of the old walk), and an
    unusable `OPENSESAME_OP_BIN` returned a command.
  - **The keepassxc bridge** (`bridge/serve/tests.rs`, 4 tests): 4 failed with
    `Ok("opensesame-keepassxc-bridge")` where an error was expected, and "left:
    opensesame-keepassxc-bridge, right: /…/opensesame-keepassxc-bridge" for the
    bridge beside `opensesame`.
  - **`OPENSESAME_NODE` for `opensesame-id`** (`vault_file/node/tests.rs`, 4
    tests): 3 failed (no link directory, no error for a bad value). The first
    version of the fix also failed its own test, which asserts the link
    directory is private: `tempfile` made it 0755, so it is created 0700.
  - **The tomb hint** named `OPENSESAME_TOMB` twice, once from the shared
    not-found message and once added by hand ("left: 2, right: 1").
  - **Windows `Path`** (`runner/tests.rs`): the discovery runner kept only a
    variable named exactly `PATH`, and a Windows snapshot says `Path`
    ("Path was dropped"). The module of fixture tests there is `cfg(unix)`, as
    the fixture is, so the daemon's test target no longer needs it on Windows.
- env-spec keeps all of its tests and messages, and adds two: no trusted entry
  means no `PATH`, and a shim's data directories reach `node`.

## Not covered by this change

Programs a person or operator names on purpose keep their own rules: the
command `dev run` starts, a `custom-command` connection's program, the
`local_authority` executable, the password-agent commands a person's policy
names (`consume`, `os_child`, `os_broker`) and the plugin binary the pin
verifies. `opensesame` re-running its own `current_exe()` is not a name at all.

Three things are decided, not missing:

- `op run` hosts a command of the person's own and hands it its environment, so
  it runs in the person's environment less interpreter hooks. Only which `op`
  it is changed.
- The keepassxc bridge is a sibling binary run in the environment the person
  gave `opensesame bridge keepassxc serve`; the rule fixes which file it is.
- A provider CLI is given the credentials it reads (`AWS_*` for `aws`, …).
  Those are the connection's own, and the Host's keys are not among them.

## Limits

- Linux only. The Windows rules are unit tests of the decision functions and a
  Windows-target `clippy --all-targets` check of `opensesame-trusted-exec`,
  `opensesame-env-spec` and `opensesame-cli-app-integration`; nothing ran on
  Windows. The daemon, connector-host and surrogate-proxy trees need a C
  toolchain for the Windows target, so their Windows builds were checked by
  reading and, for `apps/cli`, by CI's Native CLI (Windows) job. The macOS `ps`
  call is compiled only on macOS (its builder and test run here). WSL interop
  with the cleared environment was not run.
- **On Windows the rule is location only.** Any absolute `PATH` directory that
  is not the working directory is trusted, and the file is not checked. The
  default ACL of a folder created under `C:\` gives Authenticated Users modify,
  so the rule gives no protection against a planted program there. That is a
  residual risk, not a fix.
- The credential helper, pinentry and keyring variables are passed by reading
  how those programs find their state; a libsecret helper, a graphical pinentry
  and gh's keyring were not exercised, and a version manager's shim was run
  under a test stub only. The same holds for each discovery CLI's
  configuration variables (`GLAB_CONFIG_DIR`, `CLOUDSDK_CONFIG`,
  `OP_CONFIG_DIR`, ...) and for the provider CLI table above: the real CLIs
  were not run, and a variable a CLI reads that is missing from its row is a
  failure to authenticate, not a leak.
- `OPENSESAME_ID_BIN` used to accept any value, including a bare name searched
  on `PATH`; it now takes an absolute executable file only.
- An operator who relied on `GIT_SSH_COMMAND`, `GIT_SSH` or `GIT_ASKPASS` for the
  store's remote now sets `core.sshCommand` or a credential helper in git's own
  configuration instead.
- The rule closes the swap between the check and the `exec` by checking every
  directory above the program and running its real path. A program file that
  is replaced *in place* by root or the caller still runs; on Linux
  `execveat` on a descriptor opened at check time would close that, and is not
  done.
- A member of a group the caller belongs to can replace a program in a
  directory that group can write; the rule assumes the caller's own groups are
  the caller's, as the 2026-10-13 audit says.
