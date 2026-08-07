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

    tracing::info!(%args.listen, "opensesame gateway listening");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
