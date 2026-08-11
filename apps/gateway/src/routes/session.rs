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
