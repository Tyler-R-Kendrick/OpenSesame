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
use opensesame_cli_app_integration::{daemon_integration_id, sign_daemon_attest};
use serde::Deserialize;
use serde_json::json;
use sha2::Digest;

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
) -> Option<(String, bool, u32)> {
    #[cfg(unix)]
    if let Some(Extension(ConnectInfo(UdsConnectInfo(Some(cred))))) = uds.as_ref() {
        if let Some(derived) = session_id_from_pid(cred.pid) {
            return Some((derived, true, cred.pid));
        }
    }
    #[cfg(not(unix))]
    let _ = uds;
    let _ = host;
    None
}

fn uds_peer_required_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "uds_peer_required" })),
    )
        .into_response()
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
    let Json(req) = match Json::<EnsureReq>::from_request(request, &()).await {
        Ok(json) => json,
        Err(rejection) => return rejection.into_response(),
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    host.store.set_now_ms(now_millis());
    let Some((terminal_session_id, reuse, peer_pid)) = terminal_session_for_ensure(&mut host, &uds)
    else {
        return uds_peer_required_response();
    };
    let (status, request_id) = host.store.ensure(
        &terminal_session_id,
        &req.verb,
        req.reference.as_deref(),
        reuse,
        "00",
        peer_pid,
        0,
        true,
    );
    Json(json!({
        "status": status,
        "requestId": request_id,
        "daemonIntegrationId": daemon_integration_id(),
    }))
    .into_response()
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
        .list_pending()
        .into_iter()
        .map(|row| {
            json!({
                "requestId": row.request_id,
                "terminalSessionId": row.terminal_session_id,
                "verb": row.verb,
                "reference": row.reference,
                "respondNonce": row.respond_nonce,
                "argvHash": row.argv_hash,
                "peerPid": row.peer_pid,
                "peerStartTime": row.peer_start_time,
                "approvable": row.approvable,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({
        "pending": rows,
        "daemonIntegrationId": daemon_integration_id(),
    }))
    .into_response()
}

pub(crate) async fn respond(
    State(st): State<App>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    if let Err(resp) = require_paired_caller(&st, &headers) {
        return resp;
    }
    #[cfg(unix)]
    {
        let uds: UdsPeer = request
            .extensions()
            .get::<ConnectInfo<UdsConnectInfo>>()
            .copied()
            .map(Extension);
        let uds_ok = {
            let mut host = match st.cli_app_integration.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            terminal_session_for_ensure(&mut host, &uds).is_some()
        };
        if !uds_ok {
            return uds_peer_required_response();
        }
    }
    let Json(req) = match Json::<RespondReq>::from_request(request, &()).await {
        Ok(json) => json,
        Err(rejection) => return rejection.into_response(),
    };
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
