//! `OPENSESAME_NODE`: the operator names the exact `node` to run.
//!
//! The rule is `opensesame_trusted_exec::named`, the same one every program
//! `opensesame` starts by name follows: absolute, and after symlinks a regular
//! file the caller can run; exempt from the ownership checks, because an
//! operator who set it chose that file, with the same trust as
//! `OPENSESAME_ENV_PARSE` (the script it runs). It is consulted first, and a
//! value that cannot be used is an error that names the variable. It never
//! becomes the `PATH` search, because someone who set it meant it.

/// The variable the operator sets.
pub(crate) const VARIABLE: &str = "OPENSESAME_NODE";

/// The `node` `value` names, as the bridge's error.
#[cfg(all(test, unix))]
pub(crate) fn node(value: &std::ffi::OsStr) -> Result<std::path::PathBuf, crate::EnvSpecError> {
    opensesame_trusted_exec::named(VARIABLE, value)
        .map_err(|e| crate::EnvSpecError::NodeOverride(e.to_string()))
}

#[cfg(all(test, unix))]
mod tests;
