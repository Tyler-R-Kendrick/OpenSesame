//! The sealed log file the long-running roles write when asked to (ADR 0157).
//!
//! `OPENSESAME_LOG_FILE` names a file every log line of the Host, the worker and
//! the daemon is sealed into, under a key kept beside it or at
//! `OPENSESAME_LOG_KEY_FILE`. Set, it replaces stdout entirely: a sealed log that
//! cannot be opened or keyed refuses to start the process, and never falls back
//! to a plaintext file or to the console. `opensesame daemon start` sets it for
//! the daemon it launches.

use std::path::Path;

use opensesame_sealed_log::{open_sink, SealedLogSink};

pub const ENV_LOG_FILE: &str = "OPENSESAME_LOG_FILE";
pub const ENV_LOG_KEY_FILE: &str = "OPENSESAME_LOG_KEY_FILE";

/// The key file override, if the operator set one.
#[must_use]
pub fn key_override() -> Option<String> {
    std::env::var(ENV_LOG_KEY_FILE)
        .ok()
        .filter(|value| !value.is_empty())
}

/// Open the sealed log at `path`.
///
/// # Errors
///
/// Returns an error when the key or the file cannot be read, created or opened.
pub fn open(path: &Path) -> std::io::Result<SealedLogSink> {
    open_sink(path, key_override().as_deref())
}

/// The sink the environment asks for, if it asks for one. A file that was asked
/// for and cannot be opened ends the process: logging into nothing, or into the
/// clear, is not what was asked.
#[must_use]
pub fn from_env() -> Option<SealedLogSink> {
    let path = std::env::var(ENV_LOG_FILE)
        .ok()
        .filter(|value| !value.is_empty())?;
    match open(Path::new(&path)) {
        Ok(sink) => Some(sink),
        Err(error) => {
            eprintln!("opensesame: cannot open the sealed log at {path}: {error}");
            std::process::exit(2);
        }
    }
}

/// Route a panic through the logger, so it reaches the sealed file and the
/// scrubbing writer like every other line rather than a stderr nobody reads.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        tracing::error!(panic = %info, "the process panicked");
    }));
}

/// Exit with the error scrubbed if the command failed.
pub fn exit_on_error(result: anyhow::Result<()>) {
    if let Err(error) = result {
        report_fatal(&error);
    }
}

/// Report a fatal error and exit. The runtime would print it itself, straight to
/// stderr and past the scrubber; a driver or transport error can echo a URL with a
/// token in it, so it is scrubbed here, and kept in the sealed log when there is
/// one (the daemon that `daemon start` launches has no other place to say why it
/// stopped).
pub fn report_fatal(error: &anyhow::Error) -> ! {
    let text = opensesame_redaction::redact_text(&format!("{error:#}"));
    if std::env::var_os(ENV_LOG_FILE).is_some() {
        tracing::error!(error = %text, "the command failed");
    }
    eprintln!("Error: {text}");
    std::process::exit(1);
}
