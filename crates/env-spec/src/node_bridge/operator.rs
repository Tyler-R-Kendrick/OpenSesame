//! `OPENSESAME_NODE`: the operator names the exact `node` to run.
//!
//! The `PATH` search in the parent module refuses a `node` that anyone but root
//! or the caller could have replaced. Some machines put the only `node` where
//! that is so on purpose (a hosted CI image leaves `/usr/local/bin` and the
//! files in it mode 0777). An operator who sets `OPENSESAME_NODE` to an
//! absolute path has chosen that file, with the same trust as
//! `OPENSESAME_ENV_PARSE` (the script it runs): it is therefore exempt from the
//! directory and file ownership and mode checks. It is consulted first, and a
//! value that cannot be used is an error that names the variable. It never
//! becomes the `PATH` search, because someone who set it meant it.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::EnvSpecError;

/// The variable the operator sets.
pub(crate) const VARIABLE: &str = "OPENSESAME_NODE";

fn refuse(why: &str) -> EnvSpecError {
    EnvSpecError::NodeOverride(format!("{VARIABLE} {why}"))
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

/// The `node` `value` names: absolute, and (after symlinks) a regular file the
/// caller can run.
pub(crate) fn node(value: &OsStr) -> Result<PathBuf, EnvSpecError> {
    if value.is_empty() {
        return Err(refuse("is set but empty; unset it or name a file"));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(refuse(&format!(
            "must be an absolute path, not \"{}\"",
            path.display()
        )));
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return Err(refuse(&format!("does not exist: \"{}\"", path.display())));
    };
    if !meta.is_file() {
        return Err(refuse(&format!(
            "is not a regular file: \"{}\"",
            path.display()
        )));
    }
    if !executable(&meta) {
        return Err(refuse(&format!(
            "is not executable: \"{}\"",
            path.display()
        )));
    }
    Ok(path.to_path_buf())
}

#[cfg(all(test, unix))]
mod tests;
