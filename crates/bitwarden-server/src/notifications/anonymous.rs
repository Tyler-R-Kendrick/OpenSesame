//! The anonymous hub (ADR 0148 §8): a device that asked to sign in waits
//! here, by its request's id, to hear that one of the account's devices
//! answered. It learns only that — the answer itself is fetched with the
//! access code only it holds.

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;

use super::{serve, WAITING};
use crate::error::{ApiError, ApiResult};
use crate::BitwardenServer;

/// Connections one request may have waiting on it.
const PER_REQUEST: usize = 4;

#[derive(Deserialize)]
pub struct AnonymousQuery {
    #[serde(rename = "Token", alias = "token")]
    token: String,
}

/// `GET /notifications/anonymous-hub?Token=<request id>`: wait on a request
/// made in the last fifteen minutes.
///
/// # Errors
///
/// 404 for a request that is not pending, 429 when too many wait already.
pub async fn anonymous_hub(
    State(server): State<BitwardenServer>,
    Query(query): Query<AnonymousQuery>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let since = crate::routes::sign_in_request_window_start();
    let pending = server
        .db
        .bitwarden_auth_request(&query.token, since)
        .await?
        .is_some_and(|r| r.approved.is_none());
    if !pending {
        return Err(ApiError::not_found());
    }
    let (seat, rx) = server
        .hub
        .waiting
        .join(&query.token, PER_REQUEST, WAITING)
        .ok_or_else(ApiError::too_many_requests)?;
    Ok(upgrade.on_upgrade(move |socket| serve(socket, rx, seat)))
}
