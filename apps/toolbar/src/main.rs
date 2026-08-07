//! Toolbar: health, status, approve device/claim via local daemon only (ADR 0017).
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

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
        #[arg(long)]
        access_token: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = reqwest::Client::new();
    let base = cli.daemon.trim_end_matches('/');
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
            let resp = match client.get(format!("{base}/v1/toolbar/status")).send().await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("daemon unreachable at {base}: {e}");
                    std::process::exit(1);
                }
            };
            if !resp.status().is_success() {
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
            let resp = match client
                .post(format!("{base}/v1/toolbar/approve_device"))
                .json(&json!({ "user_code": user_code, "principal": principal }))
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
                eprintln!("authorize CLI failed ({status}): {body}");
                std::process::exit(1);
            }
            let v: Value = resp.json().await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Commands::ApproveClaim {
            claim_id,
            access_token,
        } => {
            let mut body = json!({ "claim_id": claim_id });
            if let Some(tok) = access_token {
                body["access_token"] = json!(tok);
            }
            let resp = match client
                .post(format!("{base}/v1/toolbar/approve_claim"))
                .json(&body)
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
                eprintln!("complete claim failed ({status}): {text}");
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
