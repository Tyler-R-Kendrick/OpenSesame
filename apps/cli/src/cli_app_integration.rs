//! Blocking CLI ↔ app integration client (daemon loopback).
#[path = "cli_app_integration_http.rs"]
mod cli_app_integration_http;

use cli_app_integration_http::{get_json_loopback, post_json_loopback, post_json_uds};
use opensesame_cli_app_integration::{
    app_unavailable_message, denied_message, expired_message, request_timeout_message,
};
use opensesame_credential_helpers::{default_sock_path, ENV_SOCK};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use url::Url;

const POLICY: &str = include_str!("../../../spec/conformance/cli-app-integration.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyDoc {
    request_timeout_seconds: u64,
    poll_interval_ms: u64,
    daemon_pin_probe_verb: String,
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

fn is_loopback_daemon_base(base: &str) -> bool {
    let trimmed = base.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = match url::Url::parse(&with_scheme) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]")
    )
}

fn health_looks_like_daemon(base: &str) -> bool {
    let (status, body) = get_json_loopback(base, "/health").unwrap_or((0, String::new()));
    if status != 200 {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(value) => value.get("status").and_then(|s| s.as_str()) == Some("ok"),
        Err(_) => false,
    }
}

fn ensure_probe_rejects_instant_approval(base: &str, path: &str, probe_verb: &str) -> bool {
    let tcp_correlation = tcp_correlation_id();
    let payload = serde_json::json!({
        "terminalSessionId": tcp_correlation,
        "verb": probe_verb,
    });
    let json_body = payload.to_string();
    let response = post_json_loopback(base, path, &json_body);
    match response {
        Ok((status, body)) if (200..300).contains(&status) => {
            let parsed = serde_json::from_str::<EnsureBody>(&body);
            match parsed {
                Ok(body) if body.status == "approved" => false,
                Ok(body) => matches!(
                    body.status.as_str(),
                    "pending" | "denied" | "expired" | "wrongSession"
                ),
                Err(_) => false,
            }
        }
        _ => false,
    }
}

/// Pin loopback `OPENSESAME_DAEMON_API` to an OpenSesame daemon before trusting ensure.
pub fn verify_local_daemon_for_cli_app_integration(base: &str) -> bool {
    if !is_loopback_daemon_base(base) {
        return false;
    }
    let policy = policy();
    if !health_looks_like_daemon(base) {
        return false;
    }
    ensure_probe_rejects_instant_approval(
        base,
        &policy.daemon_paths.ensure,
        &policy.daemon_pin_probe_verb,
    )
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

fn tcp_correlation_id() -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    hex::encode(bytes)
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
    if !verify_local_daemon_for_cli_app_integration(&base) {
        anyhow::bail!("{}", app_unavailable_message());
    }
    let policy = policy();
    let path = policy.daemon_paths.ensure.clone();
    let deadline = Instant::now() + Duration::from_secs(policy.request_timeout_seconds);
    let tcp_correlation = tcp_correlation_id();
    let payload = serde_json::json!({
        "terminalSessionId": tcp_correlation,
        "verb": verb,
        "reference": reference,
    });
    let json_body = payload.to_string();
    let daemon_sock = std::env::var_os(ENV_SOCK)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_sock_path);
    while Instant::now() < deadline {
        let response = post_json_uds(daemon_sock.as_path(), &path, &json_body)
            .or_else(|()| post_json_loopback(&base, &path, &json_body));
        match response {
            Ok((404, _)) | Ok((503, _)) => {
                anyhow::bail!("{}", app_unavailable_message());
            }
            Ok((status, body)) if (200..300).contains(&status) => {
                let parsed = serde_json::from_str::<EnsureBody>(&body)?;
                match parsed.status.as_str() {
                    "approved" => return Ok(()),
                    "expired" => anyhow::bail!("{}", expired_message()),
                    "denied" | "wrongSession" => anyhow::bail!("{}", denied_message()),
                    _ => {}
                }
            }
            Ok((_, _)) => anyhow::bail!("{}", denied_message()),
            Err(()) => anyhow::bail!("{}", app_unavailable_message()),
        }
        std::thread::sleep(Duration::from_millis(policy.poll_interval_ms));
    }
    anyhow::bail!("{}", request_timeout_message())
}
