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
//! 1. `node` is found here, by this crate, and run by its absolute path. If the
//!    operator set `OPENSESAME_NODE` to an absolute path, that file is the
//!    `node` (see `operator`): it is exempt from the checks below, and a value
//!    that cannot be used is an error, not a fallback. Otherwise only
//!    `PATH` entries that are absolute, exist and that nobody else could have
//!    put a `node` in are searched: owned by root or the caller, not writable
//!    by others, and group-writable only by root's group or one of the
//!    caller's own (`opensesame_trusted_exec::trust`). On Windows: absolute,
//!    existing and not the current directory. The `node` itself must be owned by root or the caller
//!    and not world-writable. An empty entry or a relative one means the
//!    working directory to a shell, and a `node` planted there would run with
//!    everything the process holds. When nothing is found the error says so
//!    and why each entry was skipped; the inherited `PATH` is never a fallback.
//!    This is `opensesame-trusted-exec`'s rule, the one every program
//!    `opensesame` starts by name is found by.
//! 2. The environment is built, not inherited: `PATH` reduced to those same
//!    entries, `HOME`, `TMPDIR`, `LANG` and the `LC_*` locale variables, and on
//!    Windows `SystemRoot`, `PATHEXT` and `COMSPEC`. Nothing else, so nothing
//!    named `OPENSESAME_*`, `NODE_*`, `npm_config_*` or `*_TOKEN`, `*_SECRET`,
//!    `*_PASSWORD`, `*_KEY` and no proxy setting with credentials in it can
//!    reach the bridge or anything it starts. The list below is the whole
//!    allowance; a variable is added to it only when Node cannot start
//!    without it.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;

pub(crate) use opensesame_trusted_exec::Lookup as Host;
use opensesame_trusted_exec::{resolve_in, ResolveError};
#[cfg(test)]
use opensesame_trusted_exec::{search, Caller, Owner, Skip};
pub(crate) use opensesame_trusted_exec::{Platform, LOCALE};

use crate::EnvSpecError;

mod operator;

/// Variable names the bridge may inherit, besides the `PATH` built here.
const PASSED: [&str; 3] = ["HOME", "TMPDIR", "LANG"];
/// What Node needs to start on Windows.
const PASSED_ON_WINDOWS: [&str; 3] = ["SystemRoot", "PATHEXT", "COMSPEC"];

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

/// `node` for `host`, ready for the bridge's arguments.
///
/// `OPENSESAME_NODE` is consulted first and is final: a value that cannot be
/// used is an error, never a reason to search `PATH` instead.
pub(crate) fn node_command_for(host: &Host) -> Result<Command, EnvSpecError> {
    let found = resolve_in("node", Some(operator::VARIABLE), host).map_err(|e| match e {
        ResolveError::NotFound(why) => EnvSpecError::Node(why),
        ResolveError::Override(why) => EnvSpecError::NodeOverride(why),
    })?;
    let mut command = Command::new(found.program);
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
