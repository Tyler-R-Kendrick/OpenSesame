//! OpenSesame Host API (gateway).
#![allow(clippy::result_large_err)] // axum handlers return Response in Err

mod app_state;
mod backup;
mod bootstrap;
mod config;
mod identity_mapping;
mod middleware;
mod routes;
mod task_engine;

use clap::Parser;
use config::Args;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,tower_http=info")
        .json()
        .init();

    let args = Args::parse();
    config::assert_cors_origins().map_err(anyhow::Error::msg)?;
    let state = app_state::build(args.clone()).await?;
    // The backup actor drains the transactional outbox for the process's
    // lifetime; secret mutations wake it via `backup_notify` (ADR 0039).
    tokio::spawn(backup::run(state.clone()));
    let hsts = args.resource.starts_with("https://");
    let app = opensesame_host_core::http_security::apply_http_security(
        routes::router(state),
        &config::cors_origins(),
        hsts,
    );

    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(%listen, "opensesame gateway listening");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
