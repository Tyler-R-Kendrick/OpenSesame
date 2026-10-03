//! Credential sources inside the plugin process: invoke-through's
//! `source_tool` per provider (`gh auth token` for github), run under the same
//! discipline the daemon's runner applies (ADR 0048 D6/D7).
//!
//! - **Scrubbed environment:** `env_clear` plus a short whitelist a provider
//!   CLI needs to find its own configuration and the OS keychain. Nothing
//!   named `OPENSESAME_*` reaches the tool.
//! - **No shell:** argv is exec'd directly.
//! - **Strict timeout with kill:** a tool waiting on a keychain prompt cannot
//!   wedge a request.
//! - **Capped capture into a zeroizing buffer;** stderr is discarded unread,
//!   and every error names a failure class, never output — on this path the
//!   output *is* the credential.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use opensesame_invoke_through::{source_tool, InvokeError, SourceToolSpec, TokenSource};
use secrecy::SecretString;
use zeroize::Zeroizing;

/// Same budget as the daemon's acquisition: a cold CLI start, not a prompt.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
/// A token is hundreds of bytes. Past this the run fails closed.
const MAX_CAPTURE_BYTES: usize = 16 * 1024;
const POLL: Duration = Duration::from_millis(10);

/// What a provider CLI may see of the plugin's environment.
const ENV_WHITELIST: &[&str] = &[
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "SystemRoot",
    "SYSTEMROOT",
];

/// The whitelist projection of `env`.
#[must_use]
pub fn scrubbed_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    ENV_WHITELIST
        .iter()
        .filter_map(|key| env.get(*key).map(|v| ((*key).to_owned(), v.clone())))
        .collect()
}

/// A provider's local credential command, run once per brokered call.
pub struct CliTokenSource {
    spec: SourceToolSpec,
    env: BTreeMap<String, String>,
}

impl std::fmt::Debug for CliTokenSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CliTokenSource")
            .field("binary", &self.spec.binary)
            .finish_non_exhaustive()
    }
}

impl CliTokenSource {
    /// The source for `provider_id`, or `None` when invoke-through names no
    /// local tool for it.
    #[must_use]
    pub fn for_provider(provider_id: &str, env: &BTreeMap<String, String>) -> Option<Self> {
        source_tool(provider_id).map(|spec| Self::with_spec(spec, env))
    }

    /// A source over an explicit spec (tests script one).
    #[must_use]
    pub fn with_spec(spec: SourceToolSpec, env: &BTreeMap<String, String>) -> Self {
        Self {
            spec,
            env: scrubbed_env(env),
        }
    }
}

impl TokenSource for CliTokenSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        capture(self.spec, &self.env).map_err(InvokeError::TokenUnavailable)
    }
}

fn capture(spec: SourceToolSpec, env: &BTreeMap<String, String>) -> Result<SecretString, String> {
    let program = spec.binary;
    let mut child = Command::new(program)
        .args(spec.args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| format!("{program} could not be started"))?;
    let reader = child.stdout.take().map(drain_capped);
    let exited = wait(&mut child);
    let captured = reader.and_then(join_briefly);
    match exited {
        None => return Err(format!("{program} timed out and was killed")),
        Some(false) => return Err(format!("{program} exited unsuccessfully")),
        Some(true) => {}
    }
    let (bytes, overflow) = captured.ok_or_else(|| format!("{program} output was lost"))?;
    if overflow {
        return Err(format!("{program} output exceeded the capture cap"));
    }
    let text = Zeroizing::new(
        String::from_utf8(bytes.to_vec()).map_err(|_| format!("{program} output was not utf-8"))?,
    );
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!("{program} printed no credential"));
    }
    Ok(SecretString::from(trimmed.to_owned()))
}

type Captured = (Zeroizing<Vec<u8>>, bool);

fn drain_capped(mut pipe: impl Read + Send + 'static) -> JoinHandle<Captured> {
    std::thread::spawn(move || {
        let mut kept = Zeroizing::new(Vec::new());
        let mut overflow = false;
        let mut buffer = Zeroizing::new([0_u8; 4096]);
        loop {
            let n = match pipe.read(buffer.as_mut()) {
                Ok(0) | Err(_) => return (kept, overflow),
                Ok(n) => n,
            };
            if kept.len() + n > MAX_CAPTURE_BYTES {
                overflow = true;
            } else {
                kept.extend_from_slice(&buffer[..n]);
            }
        }
    })
}

/// `Some(success)` once the child exits, `None` after the timeout kill.
fn wait(child: &mut Child) -> Option<bool> {
    let deadline = Instant::now() + ACQUIRE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// A grandchild holding the pipe open must not outwait the timeout.
fn join_briefly<T>(thread: JoinHandle<T>) -> Option<T> {
    let deadline = Instant::now() + Duration::from_millis(200);
    while !thread.is_finished() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
    thread.join().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    fn env() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            (
                "OPENSESAME_OPERATOR_TOKEN".to_owned(),
                "op-secret".to_owned(),
            ),
        ])
    }

    fn scripted(script: &'static str) -> CliTokenSource {
        let args: &'static [&'static str] = Box::leak(Box::new(["-c", script]));
        CliTokenSource::with_spec(SourceToolSpec { binary: "sh", args }, &env())
    }

    #[test]
    fn github_draws_from_gh_auth_token() {
        let source = CliTokenSource::for_provider("github", &env()).unwrap();
        assert_eq!(source.spec.binary, "gh");
        assert!(CliTokenSource::for_provider("workos", &env()).is_none());
    }

    #[test]
    fn the_printed_credential_is_acquired() {
        let token = scripted("printf 'gho_x\\n'").acquire().unwrap();
        assert_eq!(token.expose_secret(), "gho_x");
    }

    #[test]
    fn the_operator_token_never_reaches_a_provider_tool() {
        let seen = scripted("printf '%s' \"${OPENSESAME_OPERATOR_TOKEN:-absent}\"")
            .acquire()
            .unwrap();
        assert_eq!(seen.expose_secret(), "absent");
    }

    #[test]
    fn a_failing_tool_reports_a_class_not_its_output() {
        let error = scripted("echo PLANTED-OUTPUT; exit 3")
            .acquire()
            .unwrap_err();
        let rendered = format!("{error} {error:?}");
        assert!(!rendered.contains("PLANTED-OUTPUT"), "{rendered}");
        assert!(matches!(error, InvokeError::TokenUnavailable(_)));
    }

    #[test]
    fn an_oversized_output_fails_closed() {
        let error = scripted("head -c 40000 /dev/zero | tr '\\0' a")
            .acquire()
            .unwrap_err();
        assert!(format!("{error}").contains("cap"));
    }

    #[test]
    fn a_debug_names_the_tool_only() {
        let rendered = format!("{:?}", scripted("true"));
        assert!(!rendered.contains("PATH"), "{rendered}");
    }
}
