//! Which bridge script the `node` runs.
//!
//! Three places, in order:
//!
//! 1. `OPENSESAME_ENV_PARSE`, when set: the operator named the file, and it is
//!    used as named (the trust `OPENSESAME_NODE` has for the `node`).
//! 2. `opensesame-env-parse.mjs` in the directory of the running executable,
//!    after symlinks: what a release kit ships beside `opensesame`, since the
//!    checkout below does not exist on a machine that downloaded the binary.
//!    It is code that runs with the schema in hand, so it is held to the rule
//!    a `node` found on `PATH` is held to (see `trust`): the directory it is
//!    named in, and the one it resolves into, owned by root or the caller, not
//!    writable by others and group-writable only by root's group or one of the
//!    caller's; the file itself a regular file owned by root or the caller and
//!    not writable by others. A file that is there and fails is an error that
//!    says why. It never falls through to the next place: someone who could
//!    plant it could otherwise choose which script runs by breaking it.
//! 3. The checkout this crate was built from,
//!    `packages/env-spec-bridge/bin/opensesame-env-parse.mjs`: a build from
//!    source, `cargo run` and the tests.

use std::path::{Path, PathBuf};

use super::trust::{self, Owner};
use super::{Host, Platform};
use crate::EnvSpecError;

/// The variable that names the script outright.
pub(crate) const OVERRIDE: &str = "OPENSESAME_ENV_PARSE";
/// The bundled bridge's file name, beside the executable in a release kit.
pub(crate) const BESIDE: &str = "opensesame-env-parse.mjs";

/// The checkout's copy, where this crate was compiled.
fn checkout() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/env-spec-bridge/bin")
        .join(BESIDE)
}

fn refuse(path: &Path, why: &str) -> EnvSpecError {
    EnvSpecError::BridgeScript(format!(
        "the env-spec bridge beside this executable is not run: \"{}\" {why}; it must be a \
         regular file owned by root or you and not writable by others, in a directory only \
         root, you or one of your groups can write (or set {OVERRIDE} to name the bridge)",
        path.display()
    ))
}

/// `dir` as a place the bridge may be named in or resolve into.
fn check_directory(dir: &Path, host: &Host) -> Result<(), EnvSpecError> {
    let meta = std::fs::metadata(dir).map_err(|e| refuse(dir, &format!("cannot be read: {e}")))?;
    match trust::directory(Owner::from(&meta), &host.caller) {
        Some(skip) => Err(refuse(dir, &skip.reason())),
        None => Ok(()),
    }
}

/// The bridge beside `exe`, if one is there and may be run. `None` when there
/// is nothing of that name, so the checkout is tried next.
pub(crate) fn beside(exe: &Path, host: &Host) -> Result<Option<PathBuf>, EnvSpecError> {
    let exe = exe.canonicalize().unwrap_or_else(|_| exe.to_path_buf());
    let Some(dir) = exe.parent() else {
        return Ok(None);
    };
    let named = dir.join(BESIDE);
    match std::fs::symlink_metadata(&named) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(refuse(&named, &format!("cannot be read: {e}"))),
        Ok(_) => {}
    }
    let file = named
        .canonicalize()
        .map_err(|e| refuse(&named, &format!("cannot be resolved: {e}")))?;
    let meta =
        std::fs::metadata(&file).map_err(|e| refuse(&file, &format!("cannot be read: {e}")))?;
    if !meta.is_file() {
        return Err(refuse(&file, "is not a regular file"));
    }
    if host.platform == Platform::Unix {
        check_directory(dir, host)?;
        if let Some(home) = file.parent().filter(|home| *home != dir) {
            check_directory(home, host)?;
        }
        if let Some(skip) = trust::file(Owner::from(&meta), &host.caller) {
            return Err(refuse(&file, &skip.reason()));
        }
    }
    Ok(Some(file))
}

/// The script for `host`, run from `exe` (the running executable, when known).
pub(crate) fn script_for(host: &Host, exe: Option<&Path>) -> Result<PathBuf, EnvSpecError> {
    if let Some(named) = host.var(OVERRIDE) {
        return Ok(PathBuf::from(named));
    }
    if let Some(found) = exe.map(|exe| beside(exe, host)).transpose()?.flatten() {
        return Ok(found);
    }
    Ok(checkout())
}

/// The script this process runs the bridge with.
pub(crate) fn script() -> Result<PathBuf, EnvSpecError> {
    script_for(&Host::capture(), std::env::current_exe().ok().as_deref())
}

#[cfg(all(test, unix))]
mod tests;
