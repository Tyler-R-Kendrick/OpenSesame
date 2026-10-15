use axum::extract::connect_info::ConnectInfo;
#[cfg(unix)]
use axum::Extension;
use axum::{
    body::Body,
    extract::{FromRequest, State},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
#[cfg(unix)]
use opensesame_cli_app_integration::session_id_from_pid;
use opensesame_cli_app_integration::sign_daemon_attest;
use serde::Deserialize;
use serde_json::json;
use sha2::Digest;
use std::net::SocketAddr;

#[cfg(unix)]
use crate::peer_auth::UdsConnectInfo;
use crate::{App, UdsPeer};

use super::auth::{bearer, origin_of, require_paired_caller};
use super::now_millis;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureReq {
    /// Present on the wire; session id is derived from UDS peer or TCP connect info.
    #[allow(dead_code)]
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

fn terminal_session_for_ensure(
    host: &mut opensesame_cli_app_integration::CliAppIntegrationHost,
    uds: &UdsPeer,
    tcp_peer: Option<ConnectInfo<SocketAddr>>,
) -> (String, bool) {
    #[cfg(unix)]
    if let Some(Extension(ConnectInfo(UdsConnectInfo(Some(cred))))) = uds.as_ref() {
        if let Some(derived) = session_id_from_pid(cred.pid) {
            return (derived, true);
        }
    }
    #[cfg(not(unix))]
    let _ = uds;
    let peer_key = match tcp_peer {
        Some(ConnectInfo(addr)) => format!("tcp:{addr}"),
        None => format!(
            "tcp:anon-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ),
    };
    let (id, _) = host.terminal_session_for_tcp(&peer_key);
    (id, false)
}

pub(crate) async fn ensure(State(st): State<App>, request: Request<Body>) -> Response {
    #[cfg(unix)]
    let uds: UdsPeer = request
        .extensions()
        .get::<ConnectInfo<UdsConnectInfo>>()
        .copied()
        .map(Extension);
    #[cfg(not(unix))]
    let uds: UdsPeer = None;
    let tcp_peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .copied();
    let Json(req) = match Json::<EnsureReq>::from_request(request, &()).await {
        Ok(json) => json,
        Err(rejection) => return rejection.into_response(),
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store.set_now_ms(now_millis());
    let (terminal_session_id, reuse) = terminal_session_for_ensure(&mut host, &uds, tcp_peer);
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
    host.store.set_now_ms(now_millis());
    let rows = host
        .store
        .list_pending();
    let active_ids = rows
        .iter()
        .map(|row| row.terminal_session_id.clone())
        .collect::<Vec<_>>();
    host.prune_stale_tcp_terminal_sessions(&active_ids);
    let rows = rows
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
    host.store.set_now_ms(now_millis());
    let (Some(origin), Some(token)) = (origin_of(&headers), bearer(&headers)) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "cli_app_pairing_required" })),
        )
            .into_response();
    };
    let Some(binding) = host.pairings.binding_for(token, origin) else {
        return Json(json!({ "status": "wrongSession" })).into_response();
    };
    let status = match req.decision.as_str() {
        "approve" => {
            let proof = req.human_proof.as_deref().unwrap_or("");
            let (approved, passkey_sign_count) = host.store.approve(
                &req.request_id,
                &req.terminal_session_id,
                &req.respond_nonce,
                proof,
                &binding,
            );
            if approved == "wrongSession" {
                let locked = host.pairings.record_pin_proof_failure(token, origin);
                if locked {
                    host.pairings
                        .revoke_token(origin, &hex::encode(sha2::Sha256::digest(token.as_bytes())));
                }
            } else if let Some(count) = passkey_sign_count {
                host.pairings
                    .advance_webauthn_sign_count(token, origin, count);
            }
            approved
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DaemonAttestReq {
    nonce: String,
}

pub(crate) async fn daemon_attest(Json(body): Json<DaemonAttestReq>) -> Response {
    if body.nonce.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_nonce" })),
        )
            .into_response();
    }
    match sign_daemon_attest(body.nonce.trim()) {
        Some(signature_b64) => (
            StatusCode::OK,
            Json(json!({ "signatureB64": signature_b64 })),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "daemon_attest_unconfigured" })),
        )
            .into_response(),
    }
}
