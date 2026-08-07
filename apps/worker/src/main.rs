//! Connector/rotation worker — leases invocations from the control plane.
use clap::Parser;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "worker-1")]
    id: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    tracing::info!(worker=%args.id, "opensesame worker idle (invocations executed in-process by gateway in local profile)");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
