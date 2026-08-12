use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::ReceiptId;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{caller, Caller};

/// The receipt named by `id`, if it is this caller's to read. Anything else
/// reads as absent rather than forbidden, so ids cannot be probed.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
async fn owned_receipt(
    st: &AppState,
    who: &Caller,
    id: &str,
) -> Result<opensesame_domain::InvocationReceipt, Response> {
    let rid = ReceiptId::parse(id).map_err(|_| {
        (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response()
    })?;
    let owner = st
        .receipt_owners
        .lock()
        .ok()
        .and_then(|owners| owners.get(&rid.to_string()).cloned());
    if !who.owns(owner.as_ref()) {
        return Err(not_found());
    }
    match st.db.get_receipt(&rid).await {
        Ok(Some(receipt)) => Ok(receipt),
        Ok(None) => Err(not_found()),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response()),
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
}

pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    match owned_receipt(&st, &who, &id).await {
        Ok(receipt) => (StatusCode::OK, Json(receipt)).into_response(),
        Err(resp) => resp,
    }
}

pub async fn verify(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let receipt = match owned_receipt(&st, &who, &id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match st.broker.signer.verify_receipt(&receipt) {
        Ok(()) => (StatusCode::OK, Json(json!({"valid": true}))).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"valid": false, "error": e.to_string()})),
        )
            .into_response(),
    }
}
