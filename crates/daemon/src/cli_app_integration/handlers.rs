use axum::{
    body::Body,
    extract::{FromRequest, State},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use axum::extract::connect_info::ConnectInfo;
use opensesame_cli_app_integration::session_id_from_pid;
use serde::Deserialize;
use serde_json::json;

use crate::peer_auth::UdsConnectInfo;
use crate::{App, UdsPeer};

use super::auth::{bearer, pairing_error, require_paired_caller};

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
    respond_nonce: String,
    human_proof: Option<String>,
}

fn terminal_session_for_ensure(uds: &UdsPeer, body: &EnsureReq) -> (String, bool) {
    #[cfg(unix)]
    if let Some(Extension(ConnectInfo(UdsConnectInfo(cred)))) = uds.as_ref() {
        if let Some(cred) = cred {
            if let Some(derived) = session_id_from_pid(cred.pid) {
                return (derived, true);
            }
        }
    }
    let trimmed = body.terminal_session_id.trim();
    let correlation = if trimmed.is_empty() {
        format!(
            "tcp-ephemeral-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        )
    } else {
        trimmed.to_string()
    };
    (correlation, false)
}

pub(crate) async fn ensure(State(st): State<App>, request: Request<Body>) -> Response {
    let uds: UdsPeer = request
        .extensions()
        .get::<axum::extract::connect_info::ConnectInfo<UdsConnectInfo>>()
        .cloned()
        .map(Extension);
    let Json(req) = match Json::<EnsureReq>::from_request(request, &()).await {
        Ok(json) => json,
        Err(rejection) => return rejection.into_response(),
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let (terminal_session_id, reuse) = terminal_session_for_ensure(&uds, &req);
    let (status, request_id) = host.store.ensure(
        &terminal_session_id,
        &req.verb,
        req.reference.as_deref(),
        reuse,
    );
    Json(json!({ "status": status, "requestId": request_id })).into_response()
}

pub(crate) async fn pending(State(st): State<App>, headers: HeaderMap) -> Response {
    if let Err(resp) = require_paired_caller(&st, &headers) {
        return resp;
    }
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let rows = host
        .store
        .list_pending()
        .into_iter()
        .map(|row| {
            json!({
                "requestId": row.request_id,
                "terminalSessionId": row.terminal_session_id,
                "verb": row.verb,
                "reference": row.reference,
                "respondNonce": row.respond_nonce,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "pending": rows })).into_response()
}

pub(crate) async fn respond(
    State(st): State<App>,
    headers: HeaderMap,
    Json(req): Json<RespondReq>,
) -> Response {
    if let Err(resp) = require_paired_caller(&st, &headers) {
        return resp;
    }
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store
        .set_now_ms(chrono::Utc::now().timestamp_millis() as u64);
    let pairing_secret = bearer(&headers).unwrap_or("");
    let status = match req.decision.as_str() {
        "approve" => {
            let proof = req.human_proof.as_deref().unwrap_or("");
            host.store.approve(
                &req.request_id,
                &req.terminal_session_id,
                &req.respond_nonce,
                proof,
                pairing_secret,
            )
        }
        "deny" => host.store.deny(
            &req.request_id,
            &req.terminal_session_id,
            &req.respond_nonce,
        ),
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
