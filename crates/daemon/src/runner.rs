//! Scrubbed command execution for capability probes (ADR 0048 §2, contract C2).
//!
//! Probes verify CLI liveness by running e.g. `gh auth token` and looking at
//! the exit status only. This runner is the single place those child processes
//! come from, and its job is to make them safe:
//!
//! - **The CLI it means** — the bare name is found by the trusted `PATH` rule
//!   over the snapshot (`programs`), never by the shell's search: a `gh`
//!   planted in a directory anyone can write, or behind an empty entry, is
//!   never run, and so never asked for a token.
//! - **Scrubbed environment** — `env_clear` plus an allowlist per CLI, never
//!   the daemon's own environment. The daemon holds `OPENSESAME_OPERATOR_TOKEN`
//!   and friends; a probed CLI has no business seeing them.
//! - **No shell** — argv is exec'd directly, so no probe argument is ever
//!   reinterpreted.
//! - **Strict timeout with kill** — a hung CLI (a keychain unlock prompt it
//!   decides to wait on, a slow network resolver) cannot wedge discovery.
//! - **Output capped and discarded** — stdout/stderr are drained so a chatty
//!   child cannot deadlock on a full pipe, reduced to a single
//!   `stdout_non_empty` bit, and dropped. A CLI that prints a token to stdout
//!   (which is exactly what `gh auth token` does) cannot leak it through a
//!   probe: the bytes never leave this module.

use opensesame_connection_detect::{CommandRunner, CommandStatus, ProbeError};
use opensesame_trusted_exec::Platform;
use secrecy::SecretString;
use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Child, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

mod programs;
pub(crate) use programs::present;

/// How much of a child's stdout is even looked at before discarding. Probes
/// only need non-emptiness, so this stays small; anything past it is drained
/// and dropped unread.
const MAX_OBSERVED_OUTPUT_BYTES: usize = 4 * 1024;

/// How much stdout a credential-capturing run may produce. A token is
/// hundreds of bytes; this is generous and still caps memory. Past the cap
/// the run fails closed — a credential that does not fit is not a credential.
const MAX_CAPTURED_OUTPUT_BYTES: usize = 16 * 1024;

/// Poll cadence while waiting on a child under its timeout.
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// What any probed CLI may be handed, or needs to be found by: the common
/// set, the keychain's session bus, and each CLI's configuration locations
/// (`programs`). Everything else — in particular every `OPENSESAME_*`
/// variable the daemon itself was started with — is withheld from children.
pub fn minimal_child_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    minimal_child_env_on(Platform::current(), env)
}

/// [`minimal_child_env`] for a snapshot taken on `platform`.
fn minimal_child_env_on(
    platform: Platform,
    env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(name, _)| programs::admitted_on(platform, name))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

/// A [`CommandRunner`] over `std::process::Command` honoring the C2 contract.
pub struct ScrubbedCommandRunner {
    env: BTreeMap<String, String>,
}

impl ScrubbedCommandRunner {
    pub fn new(env: BTreeMap<String, String>) -> Self {
        Self { env }
    }
}

/// Drain a pipe to EOF, reporting only whether any byte was seen. Reading to
/// EOF matters as much as not keeping the bytes: a child whose pipe fills up
/// blocks forever, and the timeout kill would then be the only way out.
fn drain_non_empty(mut pipe: impl Read + Send + 'static) -> JoinHandle<bool> {
    std::thread::spawn(move || {
        let mut seen_any = false;
        let mut buffer = [0u8; MAX_OBSERVED_OUTPUT_BYTES];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => return seen_any,
                Ok(_) => seen_any = true,
            }
        }
    })
}

/// Drain a pipe to EOF into a zeroizing buffer under a hard cap. Used by
/// [`ScrubbedCommandRunner::run_capture`] — the invoke-through path, where
/// stdout *is* the credential. The second tuple element flags overflow: past
/// the cap the bytes keep draining (so the child cannot deadlock) but are no
/// longer kept, and the caller fails closed.
fn drain_capped(mut pipe: impl Read + Send + 'static, cap: usize) -> JoinHandle<Capture> {
    std::thread::spawn(move || {
        let mut captured = Zeroizing::new(Vec::new());
        let mut overflow = false;
        let mut buffer = [0u8; 4096];
        loop {
            let bytes_read = match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => return Capture { captured, overflow },
                Ok(bytes_read) => bytes_read,
            };
            if captured.len() + bytes_read > cap {
                overflow = true;
            } else {
                captured.extend_from_slice(&buffer[..bytes_read]);
            }
        }
    })
}

struct Capture {
    captured: Zeroizing<Vec<u8>>,
    overflow: bool,
}

fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_child(
    child: &mut Child,
    executable: &str,
    timeout_ms: u64,
) -> Result<Option<std::process::ExitStatus>, ProbeError> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(WAIT_POLL_INTERVAL),
            Ok(None) => {
                kill_and_reap(child);
                return Ok(None);
            }
            Err(error) => {
                kill_and_reap(child);
                return Err(ProbeError::Command(format!("wait {executable}: {error}")));
            }
        }
    }
}

/// Join a drain thread, but only briefly: a grandchild that inherited the
/// pipe (e.g. `sh -c "sleep 30"` leaving `sleep` behind after `sh` is
/// killed) holds it open past the child's death, and waiting for EOF would
/// outwait the timeout we just enforced. Past the grace period the thread is
/// detached — it ends on its own when the pipe finally closes.
fn join_briefly<T>(thread: JoinHandle<T>, grace: Duration) -> Option<T> {
    let deadline = Instant::now() + grace;
    while !thread.is_finished() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(WAIT_POLL_INTERVAL);
    }
    thread.join().ok()
}

impl ScrubbedCommandRunner {
    /// The invoke-through counterpart of `run_status` (ADR 0048 D6/D7): run a
    /// credential-emitting CLI (`gh auth token`) and capture its stdout as a
    /// [`SecretString`]. Same scrubbed environment, no shell, strict timeout
    /// with kill; stdout is captured under [`MAX_CAPTURED_OUTPUT_BYTES`] into
    /// a zeroizing buffer, stderr is drained and discarded, and every error
    /// names only the failure class (spawn, timeout, exit status, overflow) —
    /// never child output, which on this path *is* the secret.
    pub fn run_capture(&self, argv: &[&str], timeout_ms: u64) -> Result<SecretString, ProbeError> {
        let (program, arguments) = argv
            .split_first()
            .ok_or_else(|| ProbeError::Command("empty argv".to_string()))?;
        let mut child = programs::command(program, &self.env)?
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ProbeError::Command(format!("spawn {program}: {error}")))?;
        let stdout = child
            .stdout
            .take()
            .map(|pipe| drain_capped(pipe, MAX_CAPTURED_OUTPUT_BYTES));
        let stderr = child.stderr.take().map(drain_non_empty);

        let status = wait_for_child(&mut child, program, timeout_ms)?;
        let capture = stdout.and_then(|t| join_briefly(t, Duration::from_millis(200)));
        if let Some(thread) = stderr {
            let _ = join_briefly(thread, Duration::from_millis(200));
        }
        let Some(status) = status else {
            return Err(ProbeError::Command(format!(
                "{program} timed out after {timeout_ms}ms and was killed"
            )));
        };
        if !status.success() {
            // The exit status is a number, never output; stderr stays unread.
            return Err(ProbeError::Command(format!(
                "{program} exited with {status}"
            )));
        }
        let Some(capture) = capture else {
            return Err(ProbeError::Command(format!(
                "{program} output could not be collected"
            )));
        };
        if capture.overflow {
            return Err(ProbeError::Command(format!(
                "{program} output exceeded the capture cap"
            )));
        }
        let text = Zeroizing::new(
            String::from_utf8(capture.captured.to_vec())
                .map_err(|_| ProbeError::Command(format!("{program} output was not utf-8")))?,
        );
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(ProbeError::Command(format!(
                "{program} printed no credential"
            )));
        }
        Ok(SecretString::from(trimmed.to_string()))
    }
}

impl CommandRunner for ScrubbedCommandRunner {
    fn run_status(&self, argv: &[&str], timeout_ms: u64) -> Result<CommandStatus, ProbeError> {
        let (program, arguments) = argv
            .split_first()
            .ok_or_else(|| ProbeError::Command("empty argv".to_string()))?;
        let mut child = programs::command(program, &self.env)?
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ProbeError::Command(format!("spawn {program}: {error}")))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_seen = stdout.map(drain_non_empty);
        let stderr_seen = stderr.map(drain_non_empty);

        let status = wait_for_child(&mut child, program, timeout_ms)?;
        // Drain threads usually end at the child's exit; a leaked grandchild
        // holding the pipe must not extend the wait, so joins are bounded.
        let stdout_non_empty = stdout_seen
            .and_then(|t| join_briefly(t, Duration::from_millis(200)))
            .unwrap_or(false);
        if let Some(thread) = stderr_seen {
            let _ = join_briefly(thread, Duration::from_millis(200));
        }
        let Some(status) = status else {
            return Err(ProbeError::Command(format!(
                "{program} timed out after {timeout_ms}ms and was killed"
            )));
        };
        Ok(CommandStatus {
            success: status.success(),
            stdout_non_empty,
        })
    }
}

#[cfg(test)]
mod tests;
