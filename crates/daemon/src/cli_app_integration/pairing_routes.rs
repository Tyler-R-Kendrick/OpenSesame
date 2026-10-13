//! CLI app-integration pairing routes (confirm, exchange, revoke, issue).
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_cli_app_integration::{format_pairing_code, is_pairable_origin, PairingError};
use serde::Deserialize;
use serde_json::json;
use sha2::Digest;

use super::{bearer, origin_of, pairing_error};
use crate::{require_operator, App, UdsPeer};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingExchange {
    code: String,
    page_binding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingConfirm {
    code: String,
    page_binding: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingIssueReq {
    origin: String,
    url: Option<String>,
    label: Option<String>,
}

pub(crate) async fn pairing_confirm(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<PairingConfirm>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return pairing_error(StatusCode::FORBIDDEN, "origin_required");
    };
    let now = chrono::Utc::now().timestamp() as u64;
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host
        .pairings
        .confirm(&body.code, origin, &body.page_binding, now)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PairingError::WrongOrigin) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Unknown | PairingError::Expired | PairingError::InvalidOrigin) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Full | PairingError::NotConfirmed) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
    }
}

pub(crate) async fn pairing_exchange(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<PairingExchange>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return pairing_error(StatusCode::FORBIDDEN, "origin_required");
    };
    let now = chrono::Utc::now().timestamp() as u64;
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host
        .pairings
        .exchange(&body.code, origin, &body.page_binding, now)
    {
        Ok(issued) => (
            StatusCode::CREATED,
            Json(json!({
                "id": issued.id,
                "origin": issued.origin,
                "token": issued.token,
            })),
        )
            .into_response(),
        Err(PairingError::WrongOrigin) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Unknown | PairingError::Expired | PairingError::InvalidOrigin) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::NotConfirmed) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_confirm_required")
        }
        Err(PairingError::Full) => pairing_error(StatusCode::CONFLICT, "too_many_pairings"),
    }
}

pub(crate) async fn pairing_revoke(State(st): State<App>, headers: HeaderMap) -> Response {
    let (Some(origin), Some(token)) = (origin_of(&headers), bearer(&headers)) else {
        return pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required");
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let digest = sha2::Sha256::digest(token.as_bytes());
    let digest_hex = hex::encode(digest);
    let before = host.pairings.paired_len();
    host.pairings.revoke_token(origin, &digest_hex);
    if host.pairings.paired_len() < before {
        StatusCode::NO_CONTENT.into_response()
    } else {
        pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required")
    }
}

/// Operator-only: mint a pairing code for a browser origin (terminal prints it).
pub(crate) async fn pairing_issue_operator(
    State(st): State<App>,
    headers: HeaderMap,
    uds: UdsPeer,
    Json(body): Json<PairingIssueReq>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    if !is_pairable_origin(&body.origin) {
        return pairing_error(StatusCode::BAD_REQUEST, "invalid_origin");
    }
    let now = chrono::Utc::now().timestamp() as u64;
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host.pairings.issue(&body.origin, now) {
        Ok((code, expires_at)) => {
            let url = body
                .url
                .as_deref()
                .unwrap_or("http://127.0.0.1:18790");
            let label = body.label.as_deref().unwrap_or("CLI");
            Json(json!({
                "pairingCode": format_pairing_code(url, &code, &body.origin, label),
                "origin": body.origin,
                "expiresAt": expires_at,
            }))
            .into_response()
        }
        Err(PairingError::Full) => pairing_error(StatusCode::CONFLICT, "too_many_pairings"),
        Err(PairingError::InvalidOrigin) => {
            pairing_error(StatusCode::BAD_REQUEST, "invalid_origin")
        }
        Err(
            PairingError::Unknown
            | PairingError::Expired
            | PairingError::WrongOrigin
            | PairingError::NotConfirmed,
        ) => pairing_error(StatusCode::INTERNAL_SERVER_ERROR, "pairing_refused"),
    }
}
