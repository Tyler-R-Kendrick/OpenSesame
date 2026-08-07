use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{
    require_demo_bootstrap, require_session_or_operator, resolve_caller_subject,
};

pub async fn status(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let n = st.sessions.lock().unwrap().len();
    Json(json!({"active_sessions": n})).into_response()
}

pub async fn whoami(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let boot = match require_demo_bootstrap(&st) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    Json(json!({
        "principal_id": subject,
        "actor_id": boot.actor.to_string(),
        "client_id": "cli:opensesame",
        "issuer": st.issuer,
        "assurance": "mfa",
        "context": format!("{}/{}/", boot.org, boot.project)
    }))
    .into_response()
}

pub async fn list_connections(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let Some(connection_ref) = &st.connection_ref else {
        return Json(json!({"connections": []})).into_response();
    };
    // Agent surface: ConnectionRef only — never SecretRef / raw credential handles.
    Json(json!({
        "connections": [{
            "connection_ref": connection_ref.handle.uri(),
            "connection_id": connection_ref.connection_id.to_string(),
            "logical_name": connection_ref.handle.logical_name,
            "max_invoke_level": 2,
            "operations": ["repository.read", "pull_request.create"]
        }]
    }))
    .into_response()
}
