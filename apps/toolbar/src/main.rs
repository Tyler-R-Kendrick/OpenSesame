//! Toolbar stub: health + status against the local daemon (ADR 0017).
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
    /// GET /health
    Health,
    /// GET /v1/toolbar/status
    Status,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = reqwest::Client::new();
    match cli.cmd {
        Commands::Health => {
            let url = format!("{}/health", cli.daemon.trim_end_matches('/'));
            let resp = client.get(url).send().await?;
            let text = resp.text().await?;
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v)?),
                Err(_) => println!("{}", json!({"status": text.trim()})),
            }
        }
        Commands::Status => {
            let url = format!("{}/v1/toolbar/status", cli.daemon.trim_end_matches('/'));
            let resp = client.get(&url).send().await?;
            if !resp.status().is_success() {
                // Fall back to /health for older credential-agent
                let health = client
                    .get(format!("{}/health", cli.daemon.trim_end_matches('/')))
                    .send()
                    .await?
                    .text()
                    .await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "daemon": "legacy_or_partial",
                        "health": health.trim(),
                        "hint": "upgrade to opensesame-daemon for /v1/toolbar/status"
                    }))?
                );
                return Ok(());
            }
            let v: Value = resp.json().await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
    }
    Ok(())
}
