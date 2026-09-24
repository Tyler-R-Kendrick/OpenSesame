//! Signed provider callbacks on the Host API: `POST /webhooks/{connection}/{route}`.
//!
//! Mounted only when `OPENSESAME_CALLBACK_MASTER_KEY` is set. Each delivery
//! carries an HMAC keyed per connection, must name a registered route, and is
//! claimed once in the durable replay ledger. No callback can read a vault or
//! start work: an accepted delivery is acknowledged with `"forwarded": false`
//! and goes nowhere else. Provider OAuth callbacks are the Host API's own
//! route (ADR 0032).
mod signature;
#[cfg(test)]
mod tests;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use opensesame_storage::{callback_replay::CallbackClaim, Db};
use serde_json::json;
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const MASTER_KEY_ENV: &str = "OPENSESAME_CALLBACK_MASTER_KEY";

struct EdgeState {
    master: Zeroizing<[u8; 32]>,
    db: Db,
    routes: BTreeSet<String>,
}

/// The callback routes when a master key is configured, an empty router when
/// none is. A key or route list that is set but invalid refuses to start.
pub fn from_env(db: Db) -> anyhow::Result<Router> {
    let Ok(raw) = std::env::var(MASTER_KEY_ENV) else {
        return Ok(Router::new());
    };
    let raw = Zeroizing::new(raw);
    anyhow::ensure!(
        std::env::var("OPENSESAME_CALLBACK_FORWARDING").is_err(),
        "callback forwarding is unavailable"
    );
    anyhow::ensure!(
        raw.len() == 64,
        "callback master key must be 32 hex-encoded bytes"
    );
    let mut master = Zeroizing::new([0; 32]);
    hex::decode_to_slice(raw.as_bytes(), &mut master[..])
        .map_err(|_| anyhow::anyhow!("invalid callback master key"))?;
    anyhow::ensure!(
        master.iter().collect::<BTreeSet<_>>().len() >= 8,
        "invalid callback master key"
    );
    let registered = std::env::var("OPENSESAME_CALLBACK_ROUTES")
        .map_err(|_| anyhow::anyhow!("callback routes are required"))?;
    anyhow::ensure!(registered.len() <= 16384, "too many callback routes");
    let routes: BTreeSet<String> = registered.split(',').map(str::to_owned).collect();
    anyhow::ensure!(
        !routes.is_empty()
            && routes.len() <= 128
            && routes.iter().all(|r| signature::registered_route(r)),
        "invalid callback routes"
    );
    Ok(router(Arc::new(EdgeState { master, db, routes })))
}

fn router(state: Arc<EdgeState>) -> Router {
    Router::new()
        .route("/webhooks/{connection}/{route}", post(webhook))
        .layer(DefaultBodyLimit::max(signature::MAX_BODY))
        .with_state(state)
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
