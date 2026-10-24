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
//!    named in, the one it resolves into and the file itself owned by root or
//!    the caller, not writable by others and group-writable only by root's
//!    group or one of the caller's. A file that is there and fails is an error
//!    that says why. It never falls through to the next place: someone who
//!    could plant it could otherwise choose which script runs by breaking it.
//! 3. The checkout this crate was built from,
//!    `packages/env-spec-bridge/bin/opensesame-env-parse.mjs`: a build from
//!    source, `cargo run` and the tests. It is held to the same rule as the
//!    file beside the executable, because a release binary carries the path it
//!    was built from (`env!("CARGO_MANIFEST_DIR")`, which `--remap-path-prefix`
//!    does not rewrite, `/home/runner/work/...` on a CI runner) and a file that
//!    merely exists there is not a reason to run it: a checkout you own passes,
//!    one a stranger can write is refused and says why. When no file is there,
//!    the error says where the lookup went rather than handing `node` a path
//!    on someone else's machine.
//!
//! The check is by path, and bounded: it does not look at the directories
//! above the two it reads, as for a `node` on `PATH`, and `node` opens the file
//! a moment after it was checked. On Windows only "is a regular file" is
//! checked; a release kit is Linux only (ADR 0212).

use std::path::{Path, PathBuf};

use super::{Host, Platform};
use crate::EnvSpecError;
use opensesame_trusted_exec::trust::{self, Owner};

/// The variable that names the script outright.
pub(crate) const OVERRIDE: &str = "OPENSESAME_ENV_PARSE";
/// The bundled bridge's file name, beside the executable in a release kit.
pub(crate) const BESIDE: &str = "opensesame-env-parse.mjs";

/// The checkout's copy, where this crate was compiled. The compiler expands
/// `CARGO_MANIFEST_DIR` before any path remapping, so a release binary still
/// carries the CI runner's path here, which is why [`vet`] holds it to the same
/// rule as the bridge beside the executable.
fn checkout() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/env-spec-bridge/bin")
        .join(BESIDE)
}

/// Where a refused bridge was found, for the error.
#[derive(Clone, Copy)]
enum Place {
    BesideExecutable,
    Checkout,
}

impl Place {
    const fn said(self) -> &'static str {
        match self {
            Self::BesideExecutable => "beside this executable",
            Self::Checkout => "in the checkout this binary was built from",
        }
    }
}

fn refuse(path: &Path, why: &str, place: Place) -> EnvSpecError {
    EnvSpecError::BridgeScript(format!(
        "the env-spec bridge {} is not run: \"{}\" {why}; it must be a \
         regular file, and it and its directory must be owned by root or you and writable \
         only by root, you or one of your groups (or set {OVERRIDE} to name the bridge)",
        place.said(),
        path.display()
    ))
}

/// `dir` as a place the bridge may be named in or resolve into.
fn check_directory(dir: &Path, host: &Host, place: Place) -> Result<(), EnvSpecError> {
    let meta =
        std::fs::metadata(dir).map_err(|e| refuse(dir, &format!("cannot be read: {e}"), place))?;
    match trust::directory(Owner::from(&meta), &host.caller) {
        Some(skip) => Err(refuse(dir, &skip.reason(), place)),
        None => Ok(()),
    }
}

/// `named` as a bridge that may be run: it resolves to a regular file owned by
/// root or the caller, in directories (the one it is named in and the one it
/// resolves into) that nobody else could have written. Returns the resolved
/// file, which is what `node` is handed.
fn vet(named: &Path, host: &Host, place: Place) -> Result<PathBuf, EnvSpecError> {
    let file = named
        .canonicalize()
        .map_err(|e| refuse(named, &format!("cannot be resolved: {e}"), place))?;
    let meta = std::fs::metadata(&file)
        .map_err(|e| refuse(&file, &format!("cannot be read: {e}"), place))?;
    if !meta.is_file() {
        return Err(refuse(&file, "is not a regular file", place));
    }
    if host.platform == Platform::Unix {
        if let Some(dir) = named.parent() {
            check_directory(dir, host, place)?;
        }
        if let Some(home) = file.parent().filter(|home| Some(*home) != named.parent()) {
            check_directory(home, host, place)?;
        }
        if let Some(skip) = trust::file(Owner::from(&meta), &host.caller) {
            return Err(refuse(&file, &skip.reason(), place));
        }
    }
    Ok(file)
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
        Err(e) => {
            return Err(refuse(
                &named,
                &format!("cannot be read: {e}"),
                Place::BesideExecutable,
            ))
        }
        Ok(_) => {}
    }
    vet(&named, host, Place::BesideExecutable).map(Some)
}

/// The script for `host`, run from `exe` (the running executable, when known).
pub(crate) fn script_for(host: &Host, exe: Option<&Path>) -> Result<PathBuf, EnvSpecError> {
    resolve(host, exe, &checkout())
}

/// [`script_for`] with the checkout's copy named, so that a test can say where
/// it is, or that it is not there.
fn resolve(host: &Host, exe: Option<&Path>, checkout: &Path) -> Result<PathBuf, EnvSpecError> {
    if let Some(named) = host.var(OVERRIDE) {
        return Ok(PathBuf::from(named));
    }
    if let Some(found) = exe.map(|exe| beside(exe, host)).transpose()?.flatten() {
        return Ok(found);
    }
    if checkout.is_file() {
        return vet(checkout, host, Place::Checkout);
    }
    let looked = exe.map_or_else(
        || {
            "the running executable could not be determined, so nothing was looked for beside it"
                .to_owned()
        },
        |exe| format!("no {BESIDE} beside \"{}\"", exe.display()),
    );
    Err(EnvSpecError::BridgeScript(format!(
        "no env-spec bridge to run: {looked}, {OVERRIDE} is not set, and the checkout copy \
         \"{}\" is missing or not a file; put {BESIDE} beside the executable (a release kit has it) or \
         set {OVERRIDE} to the bridge",
        checkout.display()
    )))
}

/// The script this process runs the bridge with.
pub(crate) fn script() -> Result<PathBuf, EnvSpecError> {
    script_for(&Host::capture(), std::env::current_exe().ok().as_deref())
}

#[cfg(all(test, unix))]
mod tests;
