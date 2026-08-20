//! Shared plumbing for the OpenSesame credential helper binaries
//! (ADR 0049 §4): `git-credential-opensesame`,
//! `docker-credential-opensesame`, `opensesame-credential-process`, and
//! `opensesame-kube-exec`.
//!
//! Every helper is a **thin UDS client of the daemon's mint passthrough** —
//! no crypto, no storage, no credential handling beyond printing what the
//! daemon returned. The daemon's `POST /v1/mint` forwards to the gateway's
//! `POST /api/v1/connections/{id}/mint`, which only ever returns
//! provider-minted, short-lived, revocable derived tokens, and only for
//! connections whose owner opted into `materialization = derived_short_lived`.
//! A provider with no native mint path answers `422 unmintable` and the
//! helper fails closed — there is no fallback that decrypts a stored
//! credential.
//!
//! **Authentication is the socket itself.** The helpers connect over the
//! daemon's Unix socket, where the kernel attests the peer UID and the
//! daemon's `require_operator` authorizes same-UID callers with no token
//! (ADR 0048 §8). Helpers therefore carry no secret of their own.
//!
//! Failure discipline: any non-200 from the daemon, any I/O error, any
//! malformed response → non-zero exit with **nothing on stdout** and only a
//! failure *class* on stderr (never a token, never a response body).

use serde_json::{json, Value};
use std::fmt;
use std::path::PathBuf;
use zeroize::Zeroizing;

/// The daemon's Unix socket env override.
pub const ENV_SOCK: &str = "OPENSESAME_AGENT_SOCK";

/// Cap on a mint response; the payload is a few hundred bytes of JSON.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// Failure classes — safe for stderr by construction.
#[derive(Debug)]
pub enum HelperError {
    /// A required configuration value (env var) is missing or empty.
    Unconfigured(&'static str),
    /// The socket or the daemon could not be reached.
    Unavailable(String),
    /// The daemon answered non-200; the class string is the daemon's own
    /// `error` code (e.g. `unmintable`, `invalid_connection_id`).
    Denied(u16, String),
    /// The daemon's answer did not parse or lacked the mint shape.
    Malformed,
    /// UDS helpers are unix-only in v1 (ADR 0048 §8: Windows is TCP-only and
    /// the helpers carry no token to use it).
    UnsupportedPlatform,
}

impl fmt::Display for HelperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HelperError::Unconfigured(what) => write!(f, "not configured: set {what}"),
            HelperError::Unavailable(detail) => {
                write!(f, "daemon unavailable: {detail}")
            }
            HelperError::Denied(status, code) => {
                write!(f, "daemon denied the mint ({status} {code})")
            }
            HelperError::Malformed => write!(f, "daemon returned a malformed mint response"),
            HelperError::UnsupportedPlatform => {
                write!(
                    f,
                    "credential helpers need the daemon's unix socket (v1 is unix-only)"
                )
            }
        }
    }
}

impl std::error::Error for HelperError {}

/// The documented default socket path: `$XDG_RUNTIME_DIR/opensesame/agent.sock`
/// when set, else `~/.opensesame/agent.sock`.
pub fn default_sock_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir).join("opensesame/agent.sock");
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home).join(".opensesame/agent.sock");
    }
    PathBuf::from("opensesame/agent.sock")
}

/// Read a required, non-empty env configuration value.
pub fn required_env(key: &'static str) -> Result<String, HelperError> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(HelperError::Unconfigured(key))
}

/// A minted derived credential, straight off the daemon's mint passthrough.
/// The token lives in a [`Zeroizing`] string for its (very short) stay and is
/// never logged.
pub struct MintedCredential {
    pub derived_token: Zeroizing<String>,
    pub expires_at: Option<String>,
    pub kind: Option<String>,
    /// The full response body, for credential_process fields beyond the
    /// common ones (aws access key id / secret / session token).
    pub raw: Value,
}

/// A blocking client of the daemon's Unix socket. One request, one response,
/// connection closed — the helpers are one-shot processes.
pub struct DaemonClient {
    sock: PathBuf,
}

impl DaemonClient {
    /// Socket from `OPENSESAME_AGENT_SOCK`, else the documented default.
    pub fn from_env() -> Self {
        let sock = std::env::var_os(ENV_SOCK)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_sock_path);
        Self { sock }
    }

    pub fn new(sock: PathBuf) -> Self {
        Self { sock }
    }

    /// `POST /v1/mint` over the daemon's UDS. Peer-cred attestation is the
    /// auth — no token is sent.
    pub fn mint(
        &self,
        connection_id: &str,
        installation_id: Option<&str>,
    ) -> Result<MintedCredential, HelperError> {
        let mut body = json!({"connection_id": connection_id});
        if let Some(installation_id) = installation_id {
            body["installation_id"] = json!(installation_id);
        }
        let (status, response_body) = self.post("/v1/mint", &body)?;
        if status != 200 {
            let code = response_body
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "error".into());
            return Err(HelperError::Denied(status, code));
        }
        let raw: Value =
            serde_json::from_str(response_body.as_deref().ok_or(HelperError::Malformed)?)
                .map_err(|_| HelperError::Malformed)?;
        let token = raw
            .get("derived_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .ok_or(HelperError::Malformed)?;
        Ok(MintedCredential {
            derived_token: Zeroizing::new(token.to_string()),
            expires_at: raw
                .get("expires_at")
                .and_then(Value::as_str)
                .map(str::to_string),
            kind: raw.get("kind").and_then(Value::as_str).map(str::to_string),
            raw,
        })
    }

    #[cfg(unix)]
    fn post(&self, path: &str, body: &Value) -> Result<(u16, Option<String>), HelperError> {
        use std::io::{Read, Write};
        let payload = serde_json::to_string(body).map_err(|_| HelperError::Malformed)?;
        let mut stream = std::os::unix::net::UnixStream::connect(&self.sock)
            .map_err(|error| HelperError::Unavailable(error.to_string()))?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .ok();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(10)))
            .ok();
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|error| HelperError::Unavailable(error.to_string()))?;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&chunk[..n]);
                    if raw.len() > MAX_RESPONSE_BYTES {
                        return Err(HelperError::Malformed);
                    }
                }
                Err(error) => return Err(HelperError::Unavailable(error.to_string())),
            }
        }
        let text = String::from_utf8(raw).map_err(|_| HelperError::Malformed)?;
        let (head, body) = text.split_once("\r\n\r\n").ok_or(HelperError::Malformed)?;
        let status_line = head.lines().next().ok_or(HelperError::Malformed)?;
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or(HelperError::Malformed)?;
        Ok((status, Some(body.trim_end_matches('\0').to_string())))
    }

    #[cfg(not(unix))]
    fn post(&self, _path: &str, _body: &Value) -> Result<(u16, Option<String>), HelperError> {
        Err(HelperError::UnsupportedPlatform)
    }
}

/// git credential helper protocol (input side): `key=value` lines terminated
/// by a blank line.
pub mod git_protocol {
    use std::collections::BTreeMap;

    pub fn parse_input(input: &str) -> BTreeMap<String, String> {
        input
            .lines()
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once('='))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    /// `get` output: username/password lines, blank-line terminated.
    pub fn render_credential(username: &str, password: &str) -> String {
        format!("username={username}\npassword={password}\n\n")
    }
}

/// docker credential helper output for `get`.
pub mod docker_protocol {
    use serde_json::{json, Value};

    pub fn render_credential(server_url: &str, username: &str, secret: &str) -> String {
        // serde_json rendering, not string interpolation: a registry URL or
        // username with a quote must not corrupt the JSON.
        let value: Value = json!({
            "ServerURL": server_url,
            "Username": username,
            "Secret": secret,
        });
        format!("{value}\n")
    }

    pub fn render_empty_list() -> &'static str {
        "{}\n"
    }
}

/// AWS `credential_process` output shape.
pub mod aws_protocol {
    use serde_json::{json, Value};

    pub fn render_credentials(
        access_key_id: &str,
        secret_access_key: &str,
        session_token: &str,
        expiration: Option<&str>,
    ) -> String {
        let mut value = json!({
            "Version": 1,
            "AccessKeyId": access_key_id,
            "SecretAccessKey": secret_access_key,
            "SessionToken": session_token,
        });
        if let Some(expiration) = expiration {
            value["Expiration"] = Value::String(expiration.to_string());
        }
        format!("{value}\n")
    }
}

/// kubectl client-go exec plugin output shape.
pub mod kube_protocol {
    use serde_json::{json, Value};

    pub fn render_exec_credential(token: &str, expiration: Option<&str>) -> String {
        let mut status = json!({"token": token});
        if let Some(expiration) = expiration {
            status["expirationTimestamp"] = Value::String(expiration.to_string());
        }
        let value = json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "kind": "ExecCredential",
            "status": status,
        });
        format!("{value}\n")
    }
}

/// Exit the process with a failure class on stderr and nothing on stdout.
pub fn fail(error: HelperError) -> ! {
    eprintln!("opensesame: {error}");
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_input_parses_until_the_blank_line() {
        let parsed = git_protocol::parse_input(
            "protocol=https\nhost=github.com\npath=acme/catalog.git\n\nignored=after-blank\n",
        );
        assert_eq!(parsed.get("protocol").map(String::as_str), Some("https"));
        assert_eq!(parsed.get("host").map(String::as_str), Some("github.com"));
        assert_eq!(
            parsed.get("path").map(String::as_str),
            Some("acme/catalog.git")
        );
        assert!(!parsed.contains_key("ignored"));
    }

    #[test]
    fn git_output_is_the_protocol_shape() {
        let out = git_protocol::render_credential("x-access-token", "ghs_x");
        assert_eq!(out, "username=x-access-token\npassword=ghs_x\n\n");
    }

    #[test]
    fn docker_output_is_json_and_quote_safe() {
        let out = docker_protocol::render_credential("ghcr.io", "user\"name", "secret");
        let parsed: Value = serde_json::from_str(&out).expect("valid json");
        assert_eq!(parsed["ServerURL"], "ghcr.io");
        assert_eq!(parsed["Username"], "user\"name");
        assert_eq!(parsed["Secret"], "secret");
    }

    #[test]
    fn aws_output_is_the_credential_process_shape() {
        let out = aws_protocol::render_credentials(
            "AKIA",
            "secret",
            "token",
            Some("2026-08-20T03:00:00Z"),
        );
        let parsed: Value = serde_json::from_str(&out).expect("valid json");
        assert_eq!(parsed["Version"], 1);
        assert_eq!(parsed["AccessKeyId"], "AKIA");
        assert_eq!(parsed["SecretAccessKey"], "secret");
        assert_eq!(parsed["SessionToken"], "token");
        assert_eq!(parsed["Expiration"], "2026-08-20T03:00:00Z");
    }

    #[test]
    fn kube_output_is_the_exec_credential_shape() {
        let out = kube_protocol::render_exec_credential("tok", None);
        let parsed: Value = serde_json::from_str(&out).expect("valid json");
        assert_eq!(parsed["apiVersion"], "client.authentication.k8s.io/v1");
        assert_eq!(parsed["kind"], "ExecCredential");
        assert_eq!(parsed["status"]["token"], "tok");
        assert!(parsed["status"].get("expirationTimestamp").is_none());
    }

    #[test]
    fn error_messages_carry_classes_only() {
        for error in [
            HelperError::Unconfigured("OPENSESAME_GIT_CONNECTION_ID"),
            HelperError::Unavailable("connection refused".into()),
            HelperError::Denied(422, "unmintable".into()),
            HelperError::Malformed,
            HelperError::UnsupportedPlatform,
        ] {
            let rendered = error.to_string();
            assert!(!rendered.contains("token="), "{rendered}");
        }
    }
}
