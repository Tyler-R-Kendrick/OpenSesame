//! An override variable: the operator names the exact file to run.
//!
//! The `PATH` search refuses a program that anyone but root or the caller
//! could have replaced. Some machines put the only copy where that is so on
//! purpose (a hosted CI image leaves `/usr/local/bin` and the files in it mode
//! 0777). An operator who sets a program's variable (`OPENSESAME_NODE`,
//! `OPENSESAME_GIT`, ...) to an absolute path has chosen that file, with the
//! same trust as anything else they put in `opensesame`'s environment: it is
//! therefore exempt from the directory and file ownership and mode checks. It
//! is consulted first, and a value that cannot be used is an error that names
//! the variable. It never becomes the `PATH` search, because someone who set it
//! meant it.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::search::executable;
use crate::ResolveError;

fn refuse(variable: &str, why: &str) -> ResolveError {
    ResolveError::Override(format!("{variable} {why}"))
}

/// The file `value` of `variable` names: absolute, and (after symlinks) a
/// regular file the caller can run.
///
/// # Errors
///
/// [`ResolveError::Override`], naming `variable`, when `value` is empty,
/// relative, missing, not a regular file or not executable.
pub fn named(variable: &str, value: &OsStr) -> Result<PathBuf, ResolveError> {
    if value.is_empty() {
        return Err(refuse(
            variable,
            "is set but empty; unset it or name a file",
        ));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(refuse(
            variable,
            &format!("must be an absolute path, not \"{}\"", path.display()),
        ));
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return Err(refuse(
            variable,
            &format!("does not exist: \"{}\"", path.display()),
        ));
    };
    if !meta.is_file() {
        return Err(refuse(
            variable,
            &format!("is not a regular file: \"{}\"", path.display()),
        ));
    }
    if !executable(&meta) {
        return Err(refuse(
            variable,
            &format!("is not executable: \"{}\"", path.display()),
        ));
    }
    Ok(path.to_path_buf())
}

#[cfg(all(test, unix))]
mod tests;
