//! Blocking CLI ↔ app integration client (daemon loopback).
#[path = "cli_app_integration_http.rs"]
mod cli_app_integration_http;

use cli_app_integration_http::post_json_loopback;
use opensesame_cli_app_integration::{app_unavailable_message, denied_message};
use serde::Deserialize;
use std::time::{Duration, Instant};

const POLICY: &str = include_str!("../../../spec/conformance/cli-app-integration.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyDoc {
    request_timeout_seconds: u64,
    poll_interval_ms: u64,
    daemon_paths: DaemonPaths,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonPaths {
    ensure: String,
}

fn policy() -> PolicyDoc {
    serde_json::from_str(POLICY).expect("cli-app-integration.json")
}

fn daemon_base() -> Option<String> {
    let raw = std::env::var("OPENSESAME_DAEMON_API")
        .or_else(|_| std::env::var("OPENSESAME_DAEMON_LISTEN"))
        .unwrap_or_else(|_| "http://127.0.0.1:18790".to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    Some(with_scheme.trim_end_matches('/').to_string())
}

fn terminal_session_id() -> String {
    if let Ok(id) = std::env::var("OPENSESAME_CLI_TERMINAL_SESSION_ID") {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    use sha2::{Digest, Sha256};
    let tty = std::env::var("OPENSESAME_CLI_TTY").unwrap_or_default();
    let shell_pid = std::env::var("OPENSESAME_CLI_SHELL_PID").unwrap_or_default();
    let digest = Sha256::digest(format!("{tty}\0{shell_pid}").as_bytes());
    hex::encode(digest)[..32].to_string()
}

#[derive(Debug, Deserialize)]
struct EnsureBody {
    status: String,
}

/// Pass reveal gate plus optional CLI app-integration approval.
pub fn require_pass_reveal(reveal: bool) -> anyhow::Result<()> {
    opensesame_connector_host::password_agent::reveal_gate::assert_pass_reveal(reveal)?;
    if reveal {
        ensure_reveal("pass-reveal", None)?;
    }
    Ok(())
}

/// # Errors
/// When the app is unavailable or integration is denied.
pub fn ensure_reveal(verb: &str, reference: Option<&str>) -> anyhow::Result<()> {
    let base = daemon_base().ok_or_else(|| anyhow::anyhow!("{}", app_unavailable_message()))?;
    let policy = policy();
    let path = policy.daemon_paths.ensure.clone();
    let deadline = Instant::now() + Duration::from_secs(policy.request_timeout_seconds);
    let payload = serde_json::json!({
        "terminalSessionId": terminal_session_id(),
        "verb": verb,
        "reference": reference,
    });
    let json_body = payload.to_string();
    while Instant::now() < deadline {
        let response = post_json_loopback(&base, &path, &json_body);
        match response {
            Ok((404, _)) | Ok((503, _)) => {
                anyhow::bail!("{}", app_unavailable_message());
            }
            Ok((status, body)) if (200..300).contains(&status) => {
                let parsed = serde_json::from_str::<EnsureBody>(&body)?;
                match parsed.status.as_str() {
                    "approved" => return Ok(()),
                    "denied" | "wrongSession" => anyhow::bail!("{}", denied_message()),
                    _ => {}
                }
            }
            Ok((_, _)) => anyhow::bail!("{}", denied_message()),
            Err(()) => anyhow::bail!("{}", app_unavailable_message()),
        }
        std::thread::sleep(Duration::from_millis(policy.poll_interval_ms));
    }
    anyhow::bail!("{}", denied_message())
}
