use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::ReceiptId;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::require_session_or_operator;

pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let rid = match ReceiptId::parse(&id) {
        Ok(r) => r,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response();
        }
    };
    match st.db.get_receipt(&rid).await {
        Ok(Some(r)) => (StatusCode::OK, Json(r)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn verify(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let rid = match ReceiptId::parse(&id) {
        Ok(r) => r,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response();
        }
    };
    match st.db.get_receipt(&rid).await {
        Ok(Some(r)) => match st.broker.signer.verify_receipt(&r) {
            Ok(()) => (StatusCode::OK, Json(json!({"valid": true}))).into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"valid": false, "error": e.to_string()})),
            )
                .into_response(),
        },
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
