//! Toolbar: health, status, approve device/claim via local daemon only (ADR 0017).
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "opensesame-toolbar", about = "Control host via local daemon")]
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
    Health,
    Status,
    /// Forward device-code approval through the daemon to Host API.
    ApproveDevice {
        #[arg(long)]
        user_code: String,
        #[arg(long, default_value = "user:demo")]
        principal: String,
    },
    /// Forward claim-complete through the daemon to Identity API.
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
            let resp = client.get(format!("{base}/health")).send().await?;
            print_json_or_text(resp.text().await?).await?;
        }
        Commands::Status => {
            let resp = client
                .get(format!("{base}/v1/toolbar/status"))
                .send()
                .await?;
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
            let resp = client
                .post(format!("{base}/v1/toolbar/approve_device"))
                .json(&json!({ "user_code": user_code, "principal": principal }))
                .send()
                .await?;
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
            let resp = client
                .post(format!("{base}/v1/toolbar/approve_claim"))
                .json(&body)
                .send()
                .await?;
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
