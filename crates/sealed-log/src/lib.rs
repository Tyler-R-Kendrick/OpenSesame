//! An encrypted, rotating log file (ADR 0155).
//!
//! A log a process writes for itself (the daemon's `~/.opensesame/daemon.log`, a
//! Host run with `OPENSESAME_LOG_FILE`) rests sealed: every line is sealed on its
//! own under a key that lives apart from the file (its own 0600 key file, or a
//! path an operator points at a secret mount). Lines are scrubbed of secrets
//! before they reach this crate (`opensesame-redaction`'s `ScrubWriter`); sealing
//! is what keeps the rest of what a log says from resting in the clear.
//!
//! A configured sealed log that cannot be opened or keyed refuses to start the
//! process. It never falls back to a plaintext file or to stdout.

mod file;
mod read;
mod seal;

use std::path::{Path, PathBuf};

pub use file::{
    rotated_path, SealedLogFile, SealedLogSink, SealedLogWriter, DEFAULT_KEEP, DEFAULT_MAX_BYTES,
};
pub use read::{read_tail, seal_existing, UNREADABLE};
pub use seal::{open_line, seal_line, LogKey, LINE_PREFIX};

/// Where the key for `log` lives: `OPENSESAME_LOG_KEY_FILE` when set, else
/// `<log>.key` beside it.
#[must_use]
pub fn key_path_for(log: &Path, override_path: Option<&str>) -> PathBuf {
    if let Some(explicit) = override_path.filter(|value| !value.is_empty()) {
        return PathBuf::from(explicit);
    }
    let mut name = log.as_os_str().to_owned();
    name.push(".key");
    PathBuf::from(name)
}

/// Open the sealed log at `log`, creating its key beside it when there is none.
///
/// # Errors
///
/// Returns an error when the key or the file cannot be read, created or opened.
pub fn open_sink(log: &Path, key_override: Option<&str>) -> std::io::Result<SealedLogSink> {
    let key = LogKey::load_or_create(&key_path_for(log, key_override))?;
    // A log an older build wrote in the clear is sealed before it is appended to.
    seal_existing(log, &key)?;
    Ok(SealedLogSink::new(SealedLogFile::open(log, key)?))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_shared;
