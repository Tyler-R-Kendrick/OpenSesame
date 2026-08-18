//! Toolbar: health, status, approve device/claim via local daemon only (ADR 0017).
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

/// Present the operator token when there is one. Left off, the daemon says so
/// plainly, which is better than this deciding the call is pointless.
fn as_operator(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(t) if !t.is_empty() => req.header("x-opensesame-operator", t),
        _ => req,
    }
}

/// Why a refusal happened, when the reason is one the caller can fix.
fn operator_hint(status: reqwest::StatusCode, had_token: bool) -> &'static str {
    if status == reqwest::StatusCode::UNAUTHORIZED && !had_token {
        return " — set OPENSESAME_OPERATOR_TOKEN to the daemon's operator token";
    }
    ""
}

/// Operator token is for this machine. A remote base would ship it off-box.
fn assert_daemon_url_allowed(url: &str) -> Result<(), String> {
    if opensesame_host_core::daemon::base_url_is_local(url) {
        return Ok(());
    }
    Err(format!(
        "daemon URL `{url}` is not loopback; operator token stays on this machine"
    ))
}

#[derive(Parser)]
#[command(
    name = "opensesame-toolbar",
    about = "Local daemon helper for Authorize CLI / claim completion (ADR 0017)"
)]
struct Cli {
    #[arg(
        long,
        env = "OPENSESAME_DAEMON_URL",
        default_value = "http://127.0.0.1:18790"
    )]
    daemon: String,
    /// The daemon's operator token. Every route but /health is operator-gated,
    /// so without this the daemon answers 401 and nothing is approved. Prefer
    /// the environment variable so it stays out of shell history and `ps`.
    #[arg(long, env = "OPENSESAME_OPERATOR_TOKEN", hide_env_values = true)]
    operator_token: Option<String>,
    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Check daemon liveness.
    Health,
    /// Show daemon/toolbar status JSON.
    Status,
    /// Authorize CLI: forward device-code approval through the daemon.
    ApproveDevice {
        #[arg(long)]
        user_code: String,
        #[arg(long, default_value = "user:demo")]
        principal: String,
    },
    /// Complete claim ownership through the daemon to the Identity API.
    ApproveClaim {
        #[arg(long)]
        claim_id: String,
        /// The osc_clm_… claim bearer. Required: a claim id is public, and
        /// nothing attaches ownership on the strength of one. Prefer the
        /// environment variable so it stays out of shell history and `ps`.
        #[arg(long, env = "OPENSESAME_CLAIM_TOKEN", hide_env_values = true)]
        claim_token: String,
        #[arg(long, env = "OPENSESAME_ACCESS_TOKEN", hide_env_values = true)]
        access_token: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = reqwest::Client::new();
    let base = cli.daemon.trim_end_matches('/');
    assert_daemon_url_allowed(base).map_err(anyhow::Error::msg)?;
    let operator = cli.operator_token.as_deref();
    let had_token = operator.is_some_and(|t| !t.is_empty());
    match cli.cmd {
        Commands::Health => {
            let resp = client.get(format!("{base}/health")).send().await;
            match resp {
                Ok(r) => print_json_or_text(r.text().await?).await?,
                Err(e) => {
                    eprintln!("daemon unreachable at {base}: {e}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Status => {
            let resp = match as_operator(client.get(format!("{base}/v1/toolbar/status")), operator)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("daemon unreachable at {base}: {e}");
                    std::process::exit(1);
                }
            };
            if !resp.status().is_success() {
                let status = resp.status();
                // A refused status says nothing about the daemon's age, so do not
                // call it legacy: report what it was.
                if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
                {
                    let body = resp.text().await.unwrap_or_default();
                    eprintln!(
                        "status refused ({status}): {body}{}",
                        operator_hint(status, had_token)
                    );
                    std::process::exit(1);
                }
                let health = client
                    .get(format!("{base}/health"))
                    .send()
                    .await?
                    .text()
                    .await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "daemon": "legacy_or_partial",
                        "health": health.trim(),
                    }))?
                );
                return Ok(());
            }
            let v: Value = resp.json().await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Commands::ApproveDevice {
            user_code,
            principal,
        } => {
            let resp = match as_operator(
                client
                    .post(format!("{base}/v1/toolbar/approve_device"))
                    .json(&json!({ "user_code": user_code, "principal": principal })),
                operator,
            )
            .send()
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("authorize CLI failed — daemon unreachable at {base}: {e}");
                    std::process::exit(1);
                }
            };
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                eprintln!(
                    "authorize CLI failed ({status}): {body}{}",
                    operator_hint(status, had_token)
                );
                std::process::exit(1);
            }
            let v: Value = resp.json().await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Commands::ApproveClaim {
            claim_id,
            claim_token,
            access_token,
        } => {
            let mut body = json!({ "claim_id": claim_id, "claim_token": claim_token });
            if let Some(tok) = access_token {
                body["access_token"] = json!(tok);
            }
            let resp = match as_operator(
                client
                    .post(format!("{base}/v1/toolbar/approve_claim"))
                    .json(&body),
                operator,
            )
            .send()
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("complete claim failed — daemon unreachable at {base}: {e}");
                    std::process::exit(1);
                }
            };
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                eprintln!(
                    "complete claim failed ({status}): {text}{}",
                    operator_hint(status, had_token)
                );
                std::process::exit(1);
            }
            let v: Value = resp.json().await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
    }
    Ok(())
}

async fn print_json_or_text(text: String) -> anyhow::Result<()> {
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v)?),
        Err(_) => println!("{}", json!({"status": text.trim()})),
    }
    Ok(())
}

#[cfg(test)]
mod pact {
    use super::*;

    #[test]
    fn property_loopback_daemon_is_allowed() {
        assert!(assert_daemon_url_allowed("http://127.0.0.1:18790").is_ok());
        assert!(assert_daemon_url_allowed("http://localhost:18790/").is_ok());
        assert!(assert_daemon_url_allowed("https://[::1]:18790").is_ok());
    }

    #[test]
    fn adversarial_remote_daemon_is_refused() {
        for bad in [
            "https://evil.example",
            "http://10.0.0.5:18790",
            "http://127.0.0.1@evil.test/",
            "ftp://127.0.0.1:18790",
        ] {
            assert!(assert_daemon_url_allowed(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn chaos_missing_operator_hint_only_on_401() {
        assert!(operator_hint(reqwest::StatusCode::UNAUTHORIZED, false)
            .contains("OPENSESAME_OPERATOR_TOKEN"));
        assert_eq!(operator_hint(reqwest::StatusCode::UNAUTHORIZED, true), "");
        assert_eq!(operator_hint(reqwest::StatusCode::BAD_GATEWAY, false), "");
    }

    #[test]
    fn contract_source_pins_loopback_before_any_operator_header() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("main.rs"),
            &["assert_daemon_url_allowed(base)", "as_operator("],
        );
        assert!(include_str!("main.rs").contains("x-opensesame-operator"));
    }
}
