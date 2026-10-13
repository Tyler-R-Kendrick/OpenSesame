//! Which `node` reads a schema, and what it can see.
//!
//! `opensesame dev run` reads the schema before it starts the child, in a
//! process that may hold what unlocks the sealed store
//! (`OPENSESAME_STORE_PASSWORD`) beside whatever else its caller exported. The
//! bridge is Node, and Node loads and runs more than the bridge script
//! (`NODE_OPTIONS`, `NODE_PATH`, a loader named in the environment, what the
//! package manager configured). Two rules, kept in this one place so that no
//! spawn of Node takes a shortcut around them:
//!
//! 1. `node` is found here, by this crate, and run by its absolute path. Only
//!    `PATH` entries that are absolute, exist and cannot be written by group or
//!    others are searched (on Windows: absolute, existing and not the current
//!    directory). An empty entry or a relative one means the working
//!    directory to a shell, and a `node` planted there would run with
//!    everything the process holds. When nothing is found the error says so;
//!    the inherited `PATH` is never a fallback.
//! 2. The environment is built, not inherited: `PATH` reduced to those same
//!    entries, `HOME`, `TMPDIR`, `LANG` and the `LC_*` locale variables, and on
//!    Windows `SystemRoot`, `PATHEXT` and `COMSPEC`. Nothing else, so nothing
//!    named `OPENSESAME_*`, `NODE_*`, `npm_config_*` or `*_TOKEN`, `*_SECRET`,
//!    `*_PASSWORD`, `*_KEY` and no proxy setting with credentials in it can
//!    reach the bridge or anything it starts. The list below is the whole
//!    allowance; a variable is added to it only when Node cannot start
//!    without it.

use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::EnvSpecError;

/// Variable names the bridge may inherit, besides the `PATH` built here.
const PASSED: [&str; 3] = ["HOME", "TMPDIR", "LANG"];
/// The locale variables, listed rather than matched by `LC_` so that no
/// variable that merely begins that way is let through.
const LOCALE: [&str; 13] = [
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
/// What Node needs to start on Windows.
const PASSED_ON_WINDOWS: [&str; 3] = ["SystemRoot", "PATHEXT", "COMSPEC"];

/// Where the rules differ: the file name of Node, how a variable name is
/// compared, and what makes a `PATH` directory untrustworthy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Unix,
    Windows,
}

impl Platform {
    pub(crate) const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }

    const fn node_file(self) -> &'static str {
        match self {
            Self::Unix => "node",
            Self::Windows => "node.exe",
        }
    }

    fn same_name(self, a: &str, b: &str) -> bool {
        match self {
            Self::Unix => a == b,
            Self::Windows => a.eq_ignore_ascii_case(b),
        }
    }
}

/// The process state the bridge is derived from.
pub(crate) struct Host {
    pub(crate) vars: Vec<(OsString, OsString)>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) platform: Platform,
}

impl Host {
    pub(crate) fn capture() -> Self {
        Self {
            vars: std::env::vars_os().collect(),
            cwd: std::env::current_dir().ok(),
            platform: Platform::current(),
        }
    }

    fn var(&self, name: &str) -> Option<&OsStr> {
        self.vars
            .iter()
            .find(|(n, _)| n.to_str().is_some_and(|n| self.platform.same_name(n, name)))
            .map(|(_, value)| value.as_os_str())
    }
}

/// Why a `PATH` entry is not searched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Skip {
    Empty,
    Relative,
    NotADirectory,
    WritableByOthers,
    CurrentDirectory,
}

impl Skip {
    const fn reason(self) -> &'static str {
        match self {
            Self::Empty => "empty entry",
            Self::Relative => "relative",
            Self::NotADirectory => "missing or not a directory",
            Self::WritableByOthers => "writable by group or others",
            Self::CurrentDirectory => "the current directory",
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct Search {
    pub(crate) trusted: Vec<PathBuf>,
    pub(crate) skipped: Vec<(PathBuf, Skip)>,
}

#[cfg(unix)]
fn writable_by_others(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o022 != 0
}

#[cfg(not(unix))]
fn writable_by_others(_: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_: &std::fs::Metadata) -> bool {
    true
}

fn is_cwd(dir: &Path, cwd: Option<&Path>) -> bool {
    let Some(cwd) = cwd else { return false };
    match (dir.canonicalize(), cwd.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => dir == cwd,
    }
}

/// Sorts the entries of `path` into those searched, in order, and those not.
pub(crate) fn search(path: &OsStr, host: &Host) -> Search {
    let mut found = Search::default();
    for dir in std::env::split_paths(path) {
        let verdict = if dir.as_os_str().is_empty() {
            Some(Skip::Empty)
        } else if !dir.is_absolute() {
            Some(Skip::Relative)
        } else {
            match std::fs::metadata(&dir) {
                Ok(meta) if meta.is_dir() => match host.platform {
                    Platform::Unix if writable_by_others(&meta) => Some(Skip::WritableByOthers),
                    Platform::Windows if is_cwd(&dir, host.cwd.as_deref()) => {
                        Some(Skip::CurrentDirectory)
                    }
                    _ => None,
                },
                _ => Some(Skip::NotADirectory),
            }
        };
        match verdict {
            Some(skip) => found.skipped.push((dir, skip)),
            None => found.trusted.push(dir),
        }
    }
    found
}

/// The first `node` an entry of `trusted` holds, as an absolute path.
pub(crate) fn find_node(trusted: &[PathBuf], platform: Platform) -> Option<PathBuf> {
    trusted
        .iter()
        .map(|dir| dir.join(platform.node_file()))
        .find(|candidate| {
            std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file() && executable(&meta))
        })
}

fn is_passed(name: &OsStr, platform: Platform) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let listed = |names: &[&str]| names.iter().any(|n| platform.same_name(n, name));
    listed(&PASSED)
        || listed(&LOCALE)
        || (platform == Platform::Windows && listed(&PASSED_ON_WINDOWS))
}

/// The whole environment the bridge gets: the allowed variables of `vars`,
/// and `PATH` made of `trusted`.
pub(crate) fn bridge_environment(
    vars: &[(OsString, OsString)],
    trusted: &[PathBuf],
    platform: Platform,
) -> Result<Vec<(OsString, OsString)>, EnvSpecError> {
    let mut out: Vec<(OsString, OsString)> = vars
        .iter()
        .filter(|(name, _)| is_passed(name, platform))
        .cloned()
        .collect();
    let path = std::env::join_paths(trusted)
        .map_err(|e| EnvSpecError::Node(format!("PATH cannot be rebuilt: {e}")))?;
    out.push((OsString::from("PATH"), path));
    Ok(out)
}

fn not_found(path: Option<&OsStr>, found: &Search) -> EnvSpecError {
    let mut why = String::from("no usable `node`: only absolute, existing directories that ");
    why.push_str("group and others cannot write are searched, and ");
    match path {
        None => why.push_str("PATH is not set"),
        Some(_) if found.trusted.is_empty() => why.push_str("PATH has none"),
        Some(_) => {
            let searched: Vec<_> = found
                .trusted
                .iter()
                .map(|d| d.display().to_string())
                .collect();
            let _ = write!(why, "none of {} holds a `node`", searched.join(", "));
        }
    }
    if !found.skipped.is_empty() {
        why.push_str(" (skipped:");
        for (dir, skip) in &found.skipped {
            let _ = write!(why, " \"{}\" {};", dir.display(), skip.reason());
        }
        why.pop();
        why.push(')');
    }
    EnvSpecError::Node(why)
}

/// `node` for `host`, ready for the bridge's arguments.
pub(crate) fn node_command_for(host: &Host) -> Result<Command, EnvSpecError> {
    let path = host.var("PATH");
    let found = path.map(|p| search(p, host)).unwrap_or_default();
    let Some(node) = find_node(&found.trusted, host.platform) else {
        return Err(not_found(path, &found));
    };
    let mut command = Command::new(node);
    command.env_clear().envs(bridge_environment(
        &host.vars,
        &found.trusted,
        host.platform,
    )?);
    Ok(command)
}

/// `node`, found among the trusted `PATH` entries of this process and given
/// the minimal environment, ready for the bridge's arguments. The one way this
/// crate (and anything built on it) starts Node.
///
/// # Errors
///
/// Returns an error when no trusted `PATH` entry holds a `node`.
pub fn node_command() -> Result<Command, EnvSpecError> {
    node_command_for(&Host::capture())
}

#[cfg(all(test, unix))]
mod tests;
