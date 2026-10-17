//! Which file a probed CLI is, and what it is handed.
//!
//! A probe names a CLI by its bare name (`gh`, `aws`, `kubectl`). It is found
//! by `opensesame-trusted-exec`'s rule over the environment snapshot the
//! runner holds: only `PATH` entries that are absolute, existing, owned by root
//! or the daemon's user, not writable by others and group-writable only by
//! root's group or the user's own, and a file owned by root or the user and
//! not world-writable. Empty and relative entries never count, a snapshot
//! without `PATH` finds nothing, and `gh` honours `OPENSESAME_GH` as the CLI
//! does. The child starts from nothing: `PATH` reduced to the trusted entries,
//! the common set (`HOME`, `TMPDIR`, `LANG`, `LC_*`), [`BASE`], and its own
//! row of [`PROGRAMS`]: where it keeps its configuration, never a credential.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::process::Command;

use opensesame_connection_detect::ProbeError;
use opensesame_trusted_exec::{
    command_in, pass_in, resolve_in, Caller, Lookup, Pass, Platform, COMMON, COMMON_ON_WINDOWS,
};

/// What every probed CLI is handed besides `PATH` and the common set: who
/// the user is, and the runtime directory and session bus a keychain is
/// reached through.
const BASE: [Pass; 4] = [
    Pass::Name("USER"),
    Pass::Name("LOGNAME"),
    Pass::Name("XDG_RUNTIME_DIR"),
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
];

/// One probed CLI: its override variable, if it has one, and what it adds.
struct Program {
    binary: &'static str,
    override_var: Option<&'static str>,
    env: &'static [Pass],
}

/// The CLIs a liveness check or a token source runs, each with the variables
/// that say where its own configuration is.
const PROGRAMS: [Program; 6] = [
    Program {
        binary: "gh",
        override_var: Some("OPENSESAME_GH"),
        // gh's config directory, the host it answers for, and `$XDG_CONFIG_HOME/gh`.
        env: &[
            Pass::Name("GH_CONFIG_DIR"),
            Pass::Name("GH_HOST"),
            Pass::Name("XDG_CONFIG_HOME"),
        ],
    },
    Program {
        binary: "glab",
        override_var: None,
        // glab's config directory, or `$XDG_CONFIG_HOME/glab-cli`.
        env: &[Pass::Name("GLAB_CONFIG_DIR"), Pass::Name("XDG_CONFIG_HOME")],
    },
    Program {
        binary: "aws",
        override_var: None,
        // The config and credentials files `aws configure list` reads, and the
        // profile it describes; the keys themselves are never passed.
        env: &[
            Pass::Name("AWS_CONFIG_FILE"),
            Pass::Name("AWS_SHARED_CREDENTIALS_FILE"),
            Pass::Name("AWS_PROFILE"),
        ],
    },
    Program {
        binary: "gcloud",
        override_var: None,
        // gcloud's configuration directory.
        env: &[Pass::Name("CLOUDSDK_CONFIG")],
    },
    Program {
        binary: "op",
        override_var: None,
        // 1Password CLI's config directory, or `$XDG_CONFIG_HOME/op`.
        env: &[Pass::Name("OP_CONFIG_DIR"), Pass::Name("XDG_CONFIG_HOME")],
    },
    Program {
        binary: "kubectl",
        override_var: None,
        // The kubeconfig `kubectl config current-context` reads.
        env: &[Pass::Name("KUBECONFIG")],
    },
];

fn program(binary: &str) -> Option<&'static Program> {
    PROGRAMS.iter().find(|program| program.binary == binary)
}

/// Whether any probe may be handed `name`, or needs it to find a CLI: what
/// [`super::minimal_child_env`] keeps of a snapshot.
pub(super) fn admitted(name: &str) -> bool {
    let named = |pass: &Pass| match *pass {
        Pass::Name(want) => want.eq_ignore_ascii_case(name),
        Pass::Prefix(start) => name.starts_with(start),
    };
    name == "PATH"
        || COMMON
            .iter()
            .chain(&COMMON_ON_WINDOWS)
            .chain(&BASE)
            .any(named)
        || PROGRAMS
            .iter()
            .any(|program| program.override_var == Some(name) || program.env.iter().any(named))
}

fn lookup(env: &BTreeMap<String, String>) -> Lookup {
    Lookup {
        vars: env
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect(),
        cwd: None,
        platform: Platform::current(),
        caller: Caller::current(),
    }
}

/// Whether `binary` resolves to a file a probe may run, on `env`'s `PATH`.
pub(crate) fn present(binary: &str, env: &BTreeMap<String, String>) -> bool {
    let named = program(binary).and_then(|program| program.override_var);
    resolve_in(binary, named, &lookup(env)).is_ok()
}

/// `binary` found by the trusted rule over `env`, with the built environment.
pub(super) fn command(binary: &str, env: &BTreeMap<String, String>) -> Result<Command, ProbeError> {
    let lookup = lookup(env);
    let spec = program(binary);
    let mut command = command_in(binary, spec.and_then(|p| p.override_var), &lookup)
        .map_err(|error| ProbeError::Command(format!("spawn {binary}: {error}")))?;
    pass_in(&mut command, &BASE, &lookup);
    if let Some(spec) = spec {
        pass_in(&mut command, spec.env, &lookup);
    }
    Ok(command)
}
