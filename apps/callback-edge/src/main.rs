//! Narrow callback ingress. No callback can read a vault or start autonomy.
mod signature;
#[cfg(test)]
mod tests;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use opensesame_storage::{callback_replay::CallbackClaim, Db};
use serde_json::json;
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

struct EdgeState {
    master: Zeroizing<[u8; 32]>,
    db: Db,
    routes: std::collections::BTreeSet<String>,
}

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8791")]
    listen: SocketAddr,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    let public = std::env::var("OPENSESAME_CALLBACK_PUBLIC_URL").ok();
    let endpoints: Vec<&str> = public.iter().map(String::as_str).collect();
    let exposure = opensesame_host_core::deployment_mode::classify(&[&listen], &endpoints)
        .map_err(anyhow::Error::msg)?;
    opensesame_host_core::deployment_mode::from_env(exposure).map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        std::env::var("OPENSESAME_CALLBACK_FORWARDING").is_err(),
        "callback forwarding is unavailable"
    );
    let raw = Zeroizing::new(
        std::env::var("OPENSESAME_CALLBACK_MASTER_KEY")
            .map_err(|_| anyhow::anyhow!("callback master key is required"))?,
    );
    let mut master = Zeroizing::new([0; 32]);
    anyhow::ensure!(
        raw.len() == 64,
        "callback master key must be 32 hex-encoded bytes"
    );
    hex::decode_to_slice(raw.as_bytes(), &mut master[..])
        .map_err(|_| anyhow::anyhow!("invalid callback master key"))?;
    anyhow::ensure!(
        master
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            >= 8,
        "invalid callback master key"
    );
    let registered = std::env::var("OPENSESAME_CALLBACK_ROUTES")
        .map_err(|_| anyhow::anyhow!("callback routes are required"))?;
    anyhow::ensure!(registered.len() <= 16384, "too many callback routes");
    let routes: std::collections::BTreeSet<String> =
        registered.split(',').map(str::to_owned).collect();
    anyhow::ensure!(
        !routes.is_empty()
            && routes.len() <= 128
            && routes.iter().all(|r| signature::registered_route(r)),
        "invalid callback routes"
    );
    let database = std::env::var("OPENSESAME_CALLBACK_DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("durable callback database is required"))?;
    anyhow::ensure!(
        database.starts_with("sqlite:")
            && !database.contains("memory")
            && !database.contains('?')
            && database.len() > 7,
        "durable callback database is required"
    );
    let db = Db::connect_sqlite(&database)
        .await
        .map_err(|_| anyhow::anyhow!("callback database unavailable"))?;
    db.migrate()
        .await
        .map_err(|_| anyhow::anyhow!("callback database migration failed"))?;
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, router(Arc::new(EdgeState { master, db, routes }))).await?;
    Ok(())
}

fn router(state: Arc<EdgeState>) -> Router {
    opensesame_host_core::http_security::apply_security_headers(
        Router::new()
            .route(
                "/health/live",
                get(|| async { Json(json!({"status":"ok"})) }),
            )
            .route("/webhooks/{connection}/{route}", post(webhook))
            // No successful OAuth acknowledgement without an implemented single-use exchange.
            .route(
                "/oauth/callback/{profile}",
                post(|| async { refused(StatusCode::SERVICE_UNAVAILABLE) }),
            )
            .fallback(|| async { refused(StatusCode::UNAUTHORIZED) })
            .layer(DefaultBodyLimit::max(signature::MAX_BODY))
            .with_state(state),
        false,
    )
}

fn refused(status: StatusCode) -> Response {
    (status, Json(json!({"error":"callback_refused"}))).into_response()
}

async fn webhook(
    State(state): State<Arc<EdgeState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(elapsed) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return refused(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok(now) = i64::try_from(elapsed.as_secs()) else {
        return refused(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Some(delivery) = signature::verify(&state.master, &method, &uri, &headers, &body, now)
    else {
        return refused(StatusCode::UNAUTHORIZED);
    };
    if !state
        .routes
        .contains(&format!("{}/{}", delivery.connection, delivery.route))
    {
        return refused(StatusCode::UNAUTHORIZED);
    }
    match state
        .db
        .claim_callback_delivery(
            &delivery.connection,
            &delivery.delivery,
            &delivery.request_digest,
            now,
        )
        .await
    {
        Ok(CallbackClaim::New | CallbackClaim::Duplicate) => {
            Json(json!({"accepted":true,"forwarded":false})).into_response()
        }
        Ok(CallbackClaim::Mismatch) => {
            tracing::warn!("callback delivery binding mismatch");
            refused(StatusCode::UNAUTHORIZED)
        }
        Ok(CallbackClaim::Capacity) | Err(_) => refused(StatusCode::SERVICE_UNAVAILABLE),
    }
}
