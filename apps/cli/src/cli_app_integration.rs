//! Blocking CLI ↔ app integration client (daemon loopback).
use opensesame_connector_host::password_agent::app_integration::{
    app_unavailable_message, denied_message, seam_decision,
};
use serde::Deserialize;
use std::time::{Duration, Instant};

const POLICY: &str =
    include_str!("../../../spec/conformance/cli-app-integration.json");

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

/// # Errors
/// When the app is unavailable or integration is denied.
pub fn ensure_reveal(verb: &str, reference: Option<&str>) -> anyhow::Result<()> {
    if let Some(seam) = seam_decision() {
        return match seam {
            "approve" => Ok(()),
            "deny" => anyhow::bail!("{}", denied_message()),
            _ => anyhow::bail!("{}", app_unavailable_message()),
        };
    }
    let base = daemon_base().ok_or_else(|| anyhow::anyhow!("{}", app_unavailable_message()))?;
    let policy = policy();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let url = format!("{base}{}", policy.daemon_paths.ensure);
    let deadline = Instant::now() + Duration::from_secs(policy.request_timeout_seconds);
    let body = serde_json::json!({
        "terminalSessionId": terminal_session_id(),
        "verb": verb,
        "reference": reference,
    });
    while Instant::now() < deadline {
        let response = client.post(&url).json(&body).send();
        match response {
            Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND
                || resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE =>
            {
                anyhow::bail!("{}", app_unavailable_message());
            }
            Ok(resp) if !resp.status().is_success() => {
                anyhow::bail!("{}", denied_message());
            }
            Ok(resp) => {
                let parsed = resp.json::<EnsureBody>()?;
                match parsed.status.as_str() {
                    "approved" => return Ok(()),
                    "denied" | "wrongSession" => anyhow::bail!("{}", denied_message()),
                    _ => {}
                }
            }
            Err(_) => anyhow::bail!("{}", app_unavailable_message()),
        }
        std::thread::sleep(Duration::from_millis(policy.poll_interval_ms));
    }
    anyhow::bail!("{}", denied_message())
}
