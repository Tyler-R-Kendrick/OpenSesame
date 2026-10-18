//! The provider CLIs `OpenSesame` starts by name, found and fed by the trusted
//! rule of `opensesame-trusted-exec`.
//!
//! The Host's provider test, the worker's health probe and the human CLI run
//! `aws`, `az`, `gcloud`, `vault`, `op`, `bw` and the rest from argv tables the
//! code owns. The Host holds `OPENSESAME_CONNECTION_KEY`, so each of those
//! starts from nothing: `PATH` reduced to the entries only root or the caller
//! can write to, the common set (`HOME`, `TMPDIR`, `LANG`, `LC_*`), and the
//! variables that CLI reads to find its configuration and credentials. The
//! rest is never passed, and `OPENSESAME_*` is on no row. A CLI is the file
//! `OPENSESAME_<NAME>_BIN` names (`OPENSESAME_GH` for `gh`, as for the CLI), or
//! the trusted `PATH` entry that holds it.
//!
//! A program a connection names itself (`custom-command`) is not on this
//! table and keeps running as the person wrote it.

use std::ffi::OsStr;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use opensesame_trusted_exec::{
    command_in, pass_in, Lookup, Pass, ResolveError, CA_BUNDLE, PROXY, VERSION_MANAGERS,
};

/// What a CLI that keeps its token in the OS keyring, or asks a desktop app,
/// reaches it through.
const KEYRING: [Pass; 5] = [
    Pass::Name("XDG_RUNTIME_DIR"),
    Pass::Name("XDG_CONFIG_HOME"),
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
    Pass::Name("DISPLAY"),
    Pass::Name("WAYLAND_DISPLAY"),
];

/// What gpg forwards to its agent for a pinentry.
const PINENTRY: [Pass; 8] = [
    Pass::Name("GNUPGHOME"),
    Pass::Name("GPG_AGENT_INFO"),
    Pass::Name("GPG_TTY"),
    Pass::Name("TERM"),
    Pass::Name("DISPLAY"),
    Pass::Name("XAUTHORITY"),
    Pass::Name("WAYLAND_DISPLAY"),
    Pass::Name("XDG_RUNTIME_DIR"),
];

/// One provider CLI.
struct Cli {
    name: &'static str,
    /// The variable that names the exact file to run.
    override_var: &'static str,
    /// What reaches it beyond `PATH` and the common set: variable groups, each
    /// by name or prefix. The last is the CLI's own credential and
    /// configuration variables.
    env: &'static [&'static [Pass]],
}

/// Every CLI a provider adapter, probe or plan names. A test pins that no
/// catalog adapter or plan names another. Credentials the CLI reads are passed
/// on purpose: it is the connection's own.
const CLIS: [Cli; 18] = [
    Cli {
        name: "age",
        override_var: "OPENSESAME_AGE_BIN",
        env: &[],
    },
    Cli {
        name: "aws",
        override_var: "OPENSESAME_AWS_BIN",
        env: &[&PROXY, &CA_BUNDLE, &[Pass::Prefix("AWS_")]],
    },
    Cli {
        name: "az",
        override_var: "OPENSESAME_AZ_BIN",
        env: &[
            &PROXY,
            &CA_BUNDLE,
            &[Pass::Prefix("AZURE_"), Pass::Name("REQUESTS_CA_BUNDLE")],
        ],
    },
    Cli {
        name: "bao",
        override_var: "OPENSESAME_BAO_BIN",
        env: &[
            &PROXY,
            &CA_BUNDLE,
            &[Pass::Prefix("BAO_"), Pass::Prefix("VAULT_")],
        ],
    },
    Cli {
        name: "bw",
        override_var: "OPENSESAME_BW_BIN",
        env: &[
            &PROXY,
            &CA_BUNDLE,
            &[
                Pass::Prefix("BW_"),
                Pass::Name("BITWARDENCLI_APPDATA_DIR"),
                Pass::Name("NODE_EXTRA_CA_CERTS"),
            ],
        ],
    },
    Cli {
        name: "bws",
        override_var: "OPENSESAME_BWS_BIN",
        env: &[&PROXY, &CA_BUNDLE, &[Pass::Prefix("BWS_")]],
    },
    Cli {
        name: "doppler",
        override_var: "OPENSESAME_DOPPLER_BIN",
        env: &[&PROXY, &CA_BUNDLE, &KEYRING, &[Pass::Prefix("DOPPLER_")]],
    },
    Cli {
        name: "foks",
        override_var: "OPENSESAME_FOKS_BIN",
        env: &[&PROXY, &CA_BUNDLE, &KEYRING, &[Pass::Prefix("FOKS_")]],
    },
    Cli {
        name: "gcloud",
        override_var: "OPENSESAME_GCLOUD_BIN",
        env: &[
            &PROXY,
            &CA_BUNDLE,
            &[
                Pass::Prefix("CLOUDSDK_"),
                Pass::Name("GOOGLE_APPLICATION_CREDENTIALS"),
                Pass::Name("GOOGLE_CLOUD_PROJECT"),
                Pass::Name("GCLOUD_PROJECT"),
                Pass::Name("GOOGLE_CLOUD_QUOTA_PROJECT"),
            ],
        ],
    },
    Cli {
        name: "gh",
        // The one provider CLI the `opensesame` CLI also runs: the same variable.
        override_var: "OPENSESAME_GH",
        env: &[
            &PROXY,
            &CA_BUNDLE,
            &KEYRING,
            &[
                Pass::Name("GH_TOKEN"),
                Pass::Name("GITHUB_TOKEN"),
                Pass::Name("GH_ENTERPRISE_TOKEN"),
                Pass::Name("GITHUB_ENTERPRISE_TOKEN"),
                Pass::Name("GH_HOST"),
                Pass::Name("GH_CONFIG_DIR"),
            ],
        ],
    },
    Cli {
        name: "infisical",
        override_var: "OPENSESAME_INFISICAL_BIN",
        env: &[&PROXY, &CA_BUNDLE, &KEYRING, &[Pass::Prefix("INFISICAL_")]],
    },
    Cli {
        name: "keepassxc-cli",
        override_var: "OPENSESAME_KEEPASSXC_CLI_BIN",
        env: &[],
    },
    Cli {
        name: "op",
        override_var: "OPENSESAME_OP_BIN",
        env: &[&PROXY, &CA_BUNDLE, &KEYRING, &[Pass::Prefix("OP_")]],
    },
    Cli {
        name: "pass",
        override_var: "OPENSESAME_PASS_BIN",
        env: &[&PINENTRY, &[Pass::Prefix("PASSWORD_STORE_")]],
    },
    Cli {
        name: "pass-cli",
        override_var: "OPENSESAME_PASS_CLI_BIN",
        env: &[
            &PROXY,
            &CA_BUNDLE,
            &KEYRING,
            &[Pass::Prefix("PROTON_PASS_")],
        ],
    },
    Cli {
        name: "security",
        override_var: "OPENSESAME_SECURITY_BIN",
        env: &[],
    },
    Cli {
        name: "vault",
        override_var: "OPENSESAME_VAULT_BIN",
        env: &[&PROXY, &CA_BUNDLE, &[Pass::Prefix("VAULT_")]],
    },
    Cli {
        name: "ykman",
        override_var: "OPENSESAME_YKMAN_BIN",
        env: &[&[Pass::Name("XDG_RUNTIME_DIR")]],
    },
];

/// Whether `name` is a provider CLI `OpenSesame` runs.
#[cfg(test)]
pub(super) fn is_provider_cli(name: &str) -> bool {
    CLIS.iter().any(|cli| cli.name == name)
}

fn command_over(name: &str, lookup: &Lookup) -> Option<Result<Command, ResolveError>> {
    let cli = CLIS.iter().find(|cli| cli.name == name)?;
    Some(
        command_in(cli.name, Some(cli.override_var), lookup).map(|mut command| {
            pass_in(&mut command, &VERSION_MANAGERS, lookup);
            for group in cli.env {
                pass_in(&mut command, group, lookup);
            }
            command
        }),
    )
}

/// `name` run to completion with `args`. The error says why it could not be
/// started, and names the variable that would point at the file to run.
pub(super) fn output<S: AsRef<OsStr>>(
    name: &str,
    args: &[S],
    lookup: &Lookup,
) -> Result<Output, String> {
    let mut command = command_over(name, lookup)
        .ok_or_else(|| format!("{name} is not a provider CLI"))?
        .map_err(|error| error.to_string())?;
    command
        .args(args)
        .output()
        .map_err(|error| format!("{name} could not be started: {error}"))
}

/// Whether `name` ran with `args` and exited 0 within ten seconds, its output
/// discarded.
pub(super) fn succeeds(name: &str, args: &[&str], lookup: &Lookup) -> Result<bool, String> {
    let mut command = command_over(name, lookup)
        .ok_or_else(|| format!("{name} is not a provider CLI"))?
        .map_err(|error| error.to_string())?;
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("{name} could not be started: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Err(error) => return Err(format!("{name} could not be waited for: {error}")),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(false);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

#[cfg(test)]
mod tests;
