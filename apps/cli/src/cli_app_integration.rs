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
const POLICY: &str = include_str!("../../../spec/conformance/cli-app-integration.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyDoc {
    request_timeout_seconds: u64,
    poll_interval_ms: u64,
    daemon_pin_probe_verb: String,
    daemon_paths: DaemonPaths,
}

fn daemon_sock_path() -> PathBuf {
    std::env::var_os(ENV_SOCK)
        .filter(|value| !value.is_empty())
        .map_or_else(default_sock_path, PathBuf::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonPaths {
    ensure: String,
    daemon_attest: Option<String>,
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
    let Ok(url) = url::Url::parse(&with_scheme) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some(host) if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
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

fn operator_daemon_pin_public_key_spki_b64() -> Option<String> {
    if let Ok(inline) =
        std::env::var("OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_SPKI_B64")
    {
        let trimmed = inline.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let path = std::env::var("OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    std::fs::read_to_string(path.trim())
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn daemon_attest_verifies(base: &str, path: &str, public_key_spki_b64: &str) -> bool {
    use rand::Rng;
    let mut raw = [0u8; 16];
    rand::thread_rng().fill(&mut raw);
    let nonce = hex::encode(raw);
    let payload = serde_json::json!({ "nonce": nonce });
    let (status, body) =
        post_json_loopback(base, path, &payload.to_string()).unwrap_or((0, String::new()));
    if status != 200 {
        return false;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body);
    match parsed {
        Ok(value) => {
            let signature = value
                .get("signatureB64")
                .and_then(|s| s.as_str())
                .unwrap_or_default();
            opensesame_cli_app_integration::verify_daemon_attest(
                public_key_spki_b64,
                &nonce,
                signature,
            )
        }
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

/// Pin loopback `OPENSESAME_DAEMON_API` to an `opensesame` daemon before trusting ensure.
pub fn verify_local_daemon_for_cli_app_integration(base: &str) -> bool {
    if !is_loopback_daemon_base(base) {
        return false;
    }
    let policy = policy();
    if !health_looks_like_daemon(base) {
        return false;
    }
    if !ensure_probe_rejects_instant_approval(
        base,
        &policy.daemon_paths.ensure,
        &policy.daemon_pin_probe_verb,
    ) {
        return false;
    }
    match operator_daemon_pin_public_key_spki_b64() {
        Some(public_key) => {
            let path = policy
                .daemon_paths
                .daemon_attest
                .as_deref()
                .unwrap_or("/v1/cli/app-integration/daemon-attest");
            daemon_attest_verifies(base, path, &public_key)
        }
        None => false,
    }
}

fn verify_daemon_via_uds(sock: &std::path::Path, _base: &str) -> bool {
    if !health_looks_like_daemon_via_uds(sock) {
        return false;
    }
    let policy = policy();
    if !ensure_probe_rejects_instant_approval_via_uds(
        sock,
        &policy.daemon_paths.ensure,
        &policy.daemon_pin_probe_verb,
    ) {
        return false;
    }
    match operator_daemon_pin_public_key_spki_b64() {
        Some(public_key) => {
            let path = policy
                .daemon_paths
                .daemon_attest
                .as_deref()
                .unwrap_or("/v1/cli/app-integration/daemon-attest");
            daemon_attest_verifies_via_uds(sock, path, &public_key)
        }
        None => false,
    }
}

fn health_looks_like_daemon_via_uds(sock: &std::path::Path) -> bool {
    let (status, body) = post_json_uds(sock, "/health", "{}").unwrap_or((0, String::new()));
    if status != 200 {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(value) => value.get("status").and_then(|s| s.as_str()) == Some("ok"),
        Err(_) => false,
    }
}

fn ensure_probe_rejects_instant_approval_via_uds(
    sock: &std::path::Path,
    path: &str,
    probe_verb: &str,
) -> bool {
    let tcp_correlation = tcp_correlation_id();
    let payload = serde_json::json!({
        "terminalSessionId": tcp_correlation,
        "verb": probe_verb,
    });
    let json_body = payload.to_string();
    let response = post_json_uds(sock, path, &json_body);
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

fn daemon_attest_verifies_via_uds(
    sock: &std::path::Path,
    path: &str,
    public_key_spki_b64: &str,
) -> bool {
    use rand::Rng;
    let mut raw = [0u8; 16];
    rand::thread_rng().fill(&mut raw);
    let nonce = hex::encode(raw);
    let payload = serde_json::json!({ "nonce": nonce });
    let (status, body) =
        post_json_uds(sock, path, &payload.to_string()).unwrap_or((0, String::new()));
    if status != 200 {
        return false;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body);
    match parsed {
        Ok(value) => {
            let signature = value
                .get("signatureB64")
                .and_then(|s| s.as_str())
                .unwrap_or_default();
            opensesame_cli_app_integration::verify_daemon_attest(
                public_key_spki_b64,
                &nonce,
                signature,
            )
        }
        Err(_) => false,
    }
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
    use std::sync::Mutex;
    static TCP_CORRELATION: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();
    let slot = TCP_CORRELATION.get_or_init(|| Mutex::new(String::new()));
    let mut guard = slot.lock().expect("tcp correlation");
    if guard.is_empty() {
        use rand::Rng;
        let bytes: [u8; 16] = rand::thread_rng().gen();
        *guard = hex::encode(bytes);
    }
    guard.clone()
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
    let sock = daemon_sock_path();
    let sock_configured = std::env::var_os(ENV_SOCK).is_some_and(|value| !value.is_empty());
    let verified = if sock_configured {
        verify_daemon_via_uds(sock.as_path(), &base)
    } else {
        verify_local_daemon_for_cli_app_integration(&base)
    };
    if !verified {
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
    while Instant::now() < deadline {
        let response = if sock_configured {
            post_json_uds(sock.as_path(), &path, &json_body)
        } else {
            post_json_uds(sock.as_path(), &path, &json_body)
                .or_else(|()| post_json_loopback(&base, &path, &json_body))
        };
        match response {
            Ok((status, _)) if status == 404 || status == 503 => {
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
