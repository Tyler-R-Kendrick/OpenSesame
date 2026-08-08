use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::{InvocationReceipt, ReceiptId};
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
}

/// Loads a receipt the caller is allowed to see. Unowned ids answer 404 so the
/// endpoint is not an existence oracle for other principals' receipts.
async fn load_owned(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    id: &str,
) -> Result<InvocationReceipt, Response> {
    let caller = resolve_caller(st, headers)?;
    let Ok(rid) = ReceiptId::parse(id) else {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response());
    };
    match st.db.get_receipt(&rid).await {
        // Receipts name the principal, connection and operation of an invocation,
        // so a session may only read its own; operators read everything.
        Ok(Some(r)) if caller.owns(&r.principal_id) => Ok(r),
        Ok(_) => Err(not_found()),
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": msg})),
            )
                .into_response())
        }
    }
}

pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    match load_owned(&st, &headers, &id).await {
        Ok(r) => (StatusCode::OK, Json(r)).into_response(),
        Err(resp) => resp,
    }
}

pub async fn verify(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let receipt = match load_owned(&st, &headers, &id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match st.broker.signer.verify_receipt(&receipt) {
        Ok(()) => (StatusCode::OK, Json(json!({"valid": true}))).into_response(),
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"valid": false, "error": msg})),
            )
                .into_response()
        }
    }
}
