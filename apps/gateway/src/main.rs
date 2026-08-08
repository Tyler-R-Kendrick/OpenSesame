//! OpenSesame Host API (gateway).
#![allow(clippy::result_large_err)] // axum handlers return Response in Err

mod app_state;
mod bootstrap;
mod config;
mod middleware;
mod routes;

use clap::Parser;
use config::Args;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,tower_http=info")
        .json()
        .init();

    let args = Args::parse();
    let state = app_state::build(args.clone()).await?;
    let app = routes::router(state);

    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(%listen, "opensesame gateway listening");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
