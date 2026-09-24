//! Scrubbed command execution for capability probes (ADR 0048 §2, contract C2).
//!
//! Probes verify CLI liveness by running e.g. `gh auth token` and looking at
//! the exit status only. This runner is the single place those child processes
//! come from, and its job is to make them safe:
//!
//! - **Scrubbed environment** — `env_clear` plus a whitelist projection, never
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
use secrecy::SecretString;
use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

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

/// Environment variables a probed CLI legitimately needs to locate its own
/// configuration and the OS keychain (e.g. `gh` needs `HOME` to find
/// `~/.config/gh` and the D-Bus session address to reach Secret Service).
/// Everything else — in particular every `OPENSESAME_*` variable the daemon
/// itself was started with — is withheld from children.
const CHILD_ENV_WHITELIST: &[&str] = &[
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    // Windows: process creation is unhappy without it; not a secret.
    "SystemRoot",
    "SYSTEMROOT",
];

/// The child environment: a whitelist projection of an environment snapshot.
/// Callers pass the same snapshot the probes see, so `PATH` resolution and the
/// child agree on what exists.
pub fn minimal_child_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    CHILD_ENV_WHITELIST
        .iter()
        .filter_map(|key| {
            env.get(*key)
                .map(|value| ((*key).to_string(), value.clone()))
        })
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
        let mut child = Command::new(program)
            .args(arguments)
            .env_clear()
            .envs(&self.env)
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
        let mut child = Command::new(program)
            .args(arguments)
            .env_clear()
            .envs(&self.env)
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
mod tests {
    use super::*;

    fn runner_with(env: &[(&str, &str)]) -> ScrubbedCommandRunner {
        ScrubbedCommandRunner::new(
            env.iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        )
    }

    #[test]
    fn contract_child_env_is_a_whitelist_projection() {
        let mut snapshot = BTreeMap::new();
        snapshot.insert("HOME".to_string(), "/home/tester".to_string());
        snapshot.insert("PATH".to_string(), "/usr/bin".to_string());
        snapshot.insert(
            "OPENSESAME_OPERATOR_TOKEN".to_string(),
            "PLANTED-OPERATOR-TOKEN".to_string(),
        );
        snapshot.insert("AWS_SECRET_ACCESS_KEY".to_string(), "PLANTED".to_string());
        let child_env = minimal_child_env(&snapshot);
        assert!(child_env.contains_key("HOME"));
        assert!(child_env.contains_key("PATH"));
        assert!(!child_env.contains_key("OPENSESAME_OPERATOR_TOKEN"));
        assert!(!child_env.contains_key("AWS_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn adversarial_child_never_sees_the_daemons_own_environment() {
        // Even a variable set on the daemon process itself must not reach the
        // child: the runner starts from env_clear, not from inheritance.
        let planted = "OPENSESAME_PLANTED_CHILD_MUST_NOT_SEE";
        std::env::set_var(planted, "PLANTED-SECRET");
        let runner = runner_with(&[("HOME", "/tmp")]);
        let status = runner
            .run_status(
                &[
                    "sh",
                    "-c",
                    "[ -z \"$OPENSESAME_PLANTED_CHILD_MUST_NOT_SEE\" ]",
                ],
                2_000,
            )
            .expect("ran");
        assert!(status.success, "child observed the daemon's environment");
        std::env::remove_var(planted);
    }

    #[test]
    fn child_gets_the_whitelisted_minimum() {
        let runner = runner_with(&[("HOME", "/home/tester"), ("PATH", "/usr/bin:/bin")]);
        let status = runner
            .run_status(
                &[
                    "sh",
                    "-c",
                    "[ \"$HOME\" = /home/tester ] && [ -n \"$PATH\" ]",
                ],
                2_000,
            )
            .expect("ran");
        assert!(status.success);
    }

    #[test]
    fn contract_a_hung_child_is_killed_at_the_timeout() {
        let runner = runner_with(&[]);
        let started = Instant::now();
        let result = runner.run_status(&["sh", "-c", "sleep 30"], 150);
        let elapsed = started.elapsed();
        assert!(result.is_err(), "timeout must surface as an error");
        assert!(
            elapsed < Duration::from_secs(5),
            "took {elapsed:?} to give up"
        );
    }

    #[test]
    fn contract_stdout_is_reduced_to_a_non_empty_bit() {
        // `gh auth token` prints a token; the runner must prove it saw output
        // without any API that could hand the bytes back.
        let runner = runner_with(&[]);
        let status = runner
            .run_status(&["sh", "-c", "echo PLANTED-TOKEN-VALUE; exit 3"], 2_000)
            .expect("ran");
        assert!(!status.success);
        assert!(status.stdout_non_empty);
    }

    #[test]
    fn a_chatty_child_cannot_deadlock_the_pipe() {
        // Far more than the 4 KiB observation cap and more than a pipe buffer:
        // only draining keeps this from blocking forever.
        let runner = runner_with(&[]);
        let started = Instant::now();
        let status = runner
            .run_status(
                &[
                    "sh",
                    "-c",
                    "i=0; while [ $i -lt 5000 ]; do echo PLANTED-LINE; i=$((i+1)); done; exit 0",
                ],
                10_000,
            )
            .expect("ran");
        assert!(status.success);
        assert!(status.stdout_non_empty);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_missing_binary_is_an_error_not_a_panic() {
        let runner = runner_with(&[]);
        let result = runner.run_status(&["definitely-not-a-real-binary-xyz"], 1_000);
        assert!(result.is_err());
    }

    // ——— run_capture: the invoke-through acquisition path ————————————

    #[test]
    fn capture_returns_stdout_trimmed() {
        use secrecy::ExposeSecret;
        let runner = runner_with(&[]);
        let token = runner
            .run_capture(&["sh", "-c", "printf 'gho_abc123\\n'"], 2_000)
            .expect("captured");
        assert_eq!(token.expose_secret(), "gho_abc123");
    }

    #[test]
    fn capture_error_never_carries_the_secret() {
        // A failing child that printed a credential-shaped string: the error
        // must name the failure class (exit status), not the output.
        let runner = runner_with(&[]);
        let error = runner
            .run_capture(&["sh", "-c", "echo PLANTED-TOKEN-IN-OUTPUT; exit 3"], 2_000)
            .expect_err("non-zero exit");
        let rendered = format!("{error} / {error:?}");
        assert!(!rendered.contains("PLANTED-TOKEN-IN-OUTPUT"), "{rendered}");
    }

    #[test]
    fn capture_fails_closed_on_empty_output() {
        let runner = runner_with(&[]);
        let error = runner
            .run_capture(&["sh", "-c", "true"], 2_000)
            .expect_err("no credential printed");
        assert!(format!("{error}").contains("no credential"));
    }

    #[test]
    fn capture_is_capped() {
        let runner = runner_with(&[]);
        let error = runner
            .run_capture(
                &[
                    "sh",
                    "-c",
                    "i=0; while [ $i -lt 5000 ]; do echo PLANTED-LINE; i=$((i+1)); done",
                ],
                10_000,
            )
            .expect_err("oversized capture");
        assert!(format!("{error}").contains("cap"));
    }

    #[test]
    fn capture_honors_the_timeout() {
        let runner = runner_with(&[]);
        let result = runner.run_capture(&["sh", "-c", "sleep 30"], 150);
        assert!(result.is_err());
    }

    #[test]
    fn capture_child_env_is_still_scrubbed() {
        let runner = runner_with(&[("HOME", "/tmp")]);
        // The daemon's own variables must not reach the capturing child
        // either; print the planted variable — empty proves the scrub.
        let planted = "OPENSESAME_PLANTED_CAPTURE_MUST_NOT_SEE";
        std::env::set_var(planted, "PLANTED-SECRET");
        let result = runner.run_capture(
            &[
                "sh",
                "-c",
                "printf '%s' \"$OPENSESAME_PLANTED_CAPTURE_MUST_NOT_SEE\"",
            ],
            2_000,
        );
        std::env::remove_var(planted);
        // Empty stdout fails closed with "no credential" — the scrub held.
        let error = result.expect_err("scrubbed env prints nothing");
        assert!(format!("{error}").contains("no credential"));
    }
}
