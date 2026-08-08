//! Narrow public callback edge — OAuth/webhook/ACME only.
use axum::{
    extract::Path,
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use serde_json::{json, Value};
use std::net::SocketAddr;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8791")]
    listen: SocketAddr,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let app = opensesame_host_core::http_security::apply_security_headers(
        Router::new()
            .route("/health/live", get(|| async { "ok" }))
            .route("/oauth/callback/{profile}", post(oauth_callback))
            .route("/webhooks/{connection_public_id}/{route}", post(webhook)),
        false,
    );
    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(%listen, "callback-edge listening (no vault read API)");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn oauth_callback(Path(profile): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    // Store codes only ephemerally in real deploy; here acknowledge without persisting secrets.
    let _ = body.get("code");
    Json(json!({"accepted": true, "profile": profile, "forward": "signed-one-time-event"}))
}

async fn webhook(
    Path((connection_public_id, route)): Path<(String, String)>,
    Json(_body): Json<Value>,
) -> Json<Value> {
    Json(json!({
        "accepted": true,
        "connection_public_id": connection_public_id,
        "route": route
    }))
}
