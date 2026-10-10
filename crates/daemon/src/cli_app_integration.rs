//! CLI app-integration routes (`/v1/cli/app-integration/*`).
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_cli_app_integration::CliAppIntegrationStore;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};

use crate::App;

pub(crate) type SharedCliAppIntegration = Arc<Mutex<CliAppIntegrationStore>>;

pub(crate) fn fresh_store() -> SharedCliAppIntegration {
    Arc::new(Mutex::new(CliAppIntegrationStore::new()))
}

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/cli/app-integration/ensure", post(ensure))
        .route("/v1/cli/app-integration/pending", get(pending))
        .route("/v1/cli/app-integration/respond", post(respond))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureReq {
    terminal_session_id: String,
    verb: String,
    reference: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondReq {
    request_id: String,
    terminal_session_id: String,
    decision: String,
}

pub(crate) async fn ensure(State(st): State<App>, Json(req): Json<EnsureReq>) -> Response {
    let mut store = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    store.set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let (status, request_id) = store.ensure(
        &req.terminal_session_id,
        &req.verb,
        req.reference.as_deref(),
    );
    Json(json!({ "status": status, "requestId": request_id })).into_response()
}

pub(crate) async fn pending(State(st): State<App>) -> Response {
    let store = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let rows = store
        .list_pending()
        .into_iter()
        .map(|row| {
            json!({
                "requestId": row.request_id,
                "terminalSessionId": row.terminal_session_id,
                "verb": row.verb,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "pending": rows })).into_response()
}

pub(crate) async fn respond(State(st): State<App>, Json(req): Json<RespondReq>) -> Response {
    let mut store = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    store.set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let status = match req.decision.as_str() {
        "approve" => store.approve(&req.request_id, &req.terminal_session_id),
        "deny" => store.deny(&req.request_id, &req.terminal_session_id),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_decision" })),
            )
                .into_response();
        }
    };
    Json(json!({ "status": status })).into_response()
}
