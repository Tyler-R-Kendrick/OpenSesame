//! What a started program may see of its parent's environment: an allowance,
//! never "everything except". [`crate::command_in`] begins from nothing and
//! adds `PATH` and [`COMMON`]; each spawn adds its own list beside it.

use std::process::Command;

use crate::{Lookup, Platform};

/// One entry of an allowance: a variable by its exact name, or every variable
/// whose name begins a certain way. On Windows names are compared without case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    Name(&'static str),
    Prefix(&'static str),
}

impl Pass {
    fn admits(self, name: &str, platform: Platform) -> bool {
        match (self, platform) {
            (Self::Name(want), _) => platform.same_name(want, name),
            (Self::Prefix(start), Platform::Unix) => name.starts_with(start),
            (Self::Prefix(start), Platform::Windows) => name
                .get(..start.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(start)),
        }
    }
}

/// The locale variables, listed rather than matched by `LC_` so that no
/// variable that merely begins that way is let through.
pub const LOCALE: [&str; 13] = [
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_PAPER",
    "LC_NAME",
    "LC_ADDRESS",
    "LC_TELEPHONE",
    "LC_MEASUREMENT",
    "LC_IDENTIFICATION",
];

/// What every started program gets besides the `PATH` built from the trusted
/// entries: where home and scratch space are, and the locale its messages are in.
pub const COMMON: [Pass; 16] = [
    Pass::Name("HOME"),
    Pass::Name("TMPDIR"),
    Pass::Name("LANG"),
    Pass::Name(LOCALE[0]),
    Pass::Name(LOCALE[1]),
    Pass::Name(LOCALE[2]),
    Pass::Name(LOCALE[3]),
    Pass::Name(LOCALE[4]),
    Pass::Name(LOCALE[5]),
    Pass::Name(LOCALE[6]),
    Pass::Name(LOCALE[7]),
    Pass::Name(LOCALE[8]),
    Pass::Name(LOCALE[9]),
    Pass::Name(LOCALE[10]),
    Pass::Name(LOCALE[11]),
    Pass::Name(LOCALE[12]),
];

/// What a program on Windows cannot start without: the system directory, how
/// to run a command, the temporary directory and the profile it stands for
/// `HOME`, and the folders a program keeps its state in (`gh` in `%AppData%`,
/// Gpg4win's home, `gcloud`, `op`). None is a secret.
pub const COMMON_ON_WINDOWS: [Pass; 11] = [
    Pass::Name("SystemRoot"),
    Pass::Name("PATHEXT"),
    Pass::Name("COMSPEC"),
    Pass::Name("TEMP"),
    Pass::Name("TMP"),
    Pass::Name("USERPROFILE"),
    Pass::Name("APPDATA"),
    Pass::Name("LOCALAPPDATA"),
    Pass::Name("ProgramData"),
    Pass::Name("SystemDrive"),
    Pass::Name("windir"),
];

/// Where a version manager keeps what its shims run (`volta`, `asdf`, `mise`),
/// for a program that is usually one of those shims (`node`, `gh`, `aws`,
/// `kubectl`): a shim told where it lives finds the real program.
pub const VERSION_MANAGERS: [Pass; 4] = [
    Pass::Name("ASDF_DATA_DIR"),
    Pass::Name("MISE_DATA_DIR"),
    Pass::Name("XDG_DATA_HOME"),
    Pass::Name("VOLTA_HOME"),
];

/// How a Windows program started from WSL reaches Windows.
pub const WSL: [Pass; 3] = [
    Pass::Name("WSL_INTEROP"),
    Pass::Name("WSL_DISTRO_NAME"),
    Pass::Name("WSLENV"),
];

/// The proxy an operator configured, for a program that reaches the network
/// itself. Both spellings, since programs disagree on which one they read.
pub const PROXY: [Pass; 8] = [
    Pass::Name("HTTP_PROXY"),
    Pass::Name("http_proxy"),
    Pass::Name("HTTPS_PROXY"),
    Pass::Name("https_proxy"),
    Pass::Name("NO_PROXY"),
    Pass::Name("no_proxy"),
    Pass::Name("ALL_PROXY"),
    Pass::Name("all_proxy"),
];

/// The certificate authorities an operator configured, for the same programs
/// (a proxy that inspects TLS, a private forge; Nix has its own name).
pub const CA_BUNDLE: [Pass; 3] = [
    Pass::Name("SSL_CERT_FILE"),
    Pass::Name("SSL_CERT_DIR"),
    Pass::Name("NIX_SSL_CERT_FILE"),
];

/// Copies the variables of `lookup` that `allow` names onto `command`. `PATH`
/// is never copied: [`crate::command_in`] builds it from the trusted entries.
pub fn pass_in(command: &mut Command, allow: &[Pass], lookup: &Lookup) {
    for (name, value) in &lookup.vars {
        let Some(text) = name.to_str() else {
            continue;
        };
        if lookup.platform.same_name(text, "PATH") {
            continue;
        }
        if allow.iter().any(|pass| pass.admits(text, lookup.platform)) {
            command.env(name, value);
        }
    }
}

/// [`pass_in`] for this process's own environment.
pub fn pass(command: &mut Command, allow: &[Pass]) {
    pass_in(command, allow, &Lookup::capture());
}

#[cfg(test)]
mod tests;
