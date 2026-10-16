use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use opensesame_cli_app_integration::{format_pairing_code, is_pairable_origin, PairingError};
use serde::Deserialize;
use serde_json::json;
use sha2::Digest;

use crate::{require_operator, App, UdsPeer};

use super::auth::{bearer, origin_of, pairing_error};
use super::now_unix;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingExchange {
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingConfirm {
    code: String,
    device_public_key_spki_b64: String,
    pairing_signature_b64: String,
    vault_session_root_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingRegistrationArm {
    origin: String,
    registration_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingWebAuthnRegister {
    vault_session_root_digest: String,
    human_proof: String,
    credential_id_b64: String,
    public_key_spki_b64: String,
    sign_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingIssueReq {
    origin: String,
    url: Option<String>,
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PairingChallengeQuery {
    code: String,
}

pub(crate) async fn pairing_challenge(
    State(st): State<App>,
    headers: HeaderMap,
    Query(query): Query<PairingChallengeQuery>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return pairing_error(StatusCode::FORBIDDEN, "origin_required");
    };
    let now = now_unix();
    let host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let challenge = host
        .pairings
        .pairing_challenge_for_confirm(&query.code, origin, now);
    match challenge {
        Some(bytes) => (
            StatusCode::OK,
            Json(json!({
                "challengeB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
            })),
        )
            .into_response(),
        None => pairing_error(StatusCode::FORBIDDEN, "pairing_refused"),
    }
}

pub(crate) async fn pairing_confirm(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<PairingConfirm>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return pairing_error(StatusCode::FORBIDDEN, "origin_required");
    };
    let now = now_unix();
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host.pairings.confirm(
        &body.code,
        origin,
        &body.device_public_key_spki_b64,
        &body.pairing_signature_b64,
        Some(body.vault_session_root_digest.as_str()),
        now,
    ) {
        Ok(outcome) => (
            StatusCode::OK,
            Json(json!({ "registrationCode": outcome.registration_code })),
        )
            .into_response(),
        Err(
            PairingError::WrongOrigin
            | PairingError::InvalidProof
            | PairingError::Unknown
            | PairingError::Expired
            | PairingError::InvalidOrigin
            | PairingError::Full
            | PairingError::NotConfirmed
            | PairingError::RegistrationRequired
            | PairingError::RegistrationMismatch,
        ) => pairing_error(StatusCode::FORBIDDEN, "pairing_refused"),
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
    let now = now_unix();
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host.pairings.exchange(&body.code, origin, now) {
        Ok(issued) => (
            StatusCode::CREATED,
            Json(json!({
                "id": issued.id,
                "origin": issued.origin,
                "token": issued.token,
            })),
        )
            .into_response(),
        Err(PairingError::NotConfirmed) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_confirm_required")
        }
        Err(PairingError::RegistrationRequired) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_registration_required")
        }
        Err(PairingError::Full) => pairing_error(StatusCode::CONFLICT, "too_many_pairings"),
        Err(
            PairingError::WrongOrigin
            | PairingError::Unknown
            | PairingError::Expired
            | PairingError::InvalidOrigin
            | PairingError::RegistrationMismatch
            | PairingError::InvalidProof,
        ) => pairing_error(StatusCode::FORBIDDEN, "pairing_refused"),
    }
}

pub(crate) async fn pairing_register_webauthn(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<PairingWebAuthnRegister>,
) -> Response {
    let (Some(origin), Some(token)) = (origin_of(&headers), bearer(&headers)) else {
        return pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required");
    };
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let registration = opensesame_cli_app_integration::WebAuthnRegistration {
        vault_session_root_digest: body.vault_session_root_digest.clone(),
        human_proof_passkey: body.human_proof.clone(),
        credential_id_b64: body.credential_id_b64.clone(),
        public_key_spki_b64: body.public_key_spki_b64.clone(),
        sign_count: body.sign_count,
    };
    match host
        .pairings
        .register_webauthn(token, origin, &registration)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PairingError::Unknown) => {
            pairing_error(StatusCode::UNAUTHORIZED, "cli_app_pairing_required")
        }
        Err(_) => pairing_error(StatusCode::FORBIDDEN, "pairing_refused"),
    }
}

pub(crate) async fn pairing_arm_registration(
    State(st): State<App>,
    headers: HeaderMap,
    uds: UdsPeer,
    Json(body): Json<PairingRegistrationArm>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    if !is_pairable_origin(&body.origin) {
        return pairing_error(StatusCode::BAD_REQUEST, "invalid_origin");
    }
    let now = now_unix();
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host
        .pairings
        .arm_registration(&body.origin, &body.registration_code, now)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PairingError::RegistrationMismatch) => {
            pairing_error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Unknown) => pairing_error(StatusCode::NOT_FOUND, "pairing_refused"),
        Err(_) => pairing_error(StatusCode::FORBIDDEN, "pairing_refused"),
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
    let now = now_unix();
    let mut host = match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match host.pairings.issue(&body.origin, now) {
        Ok((code, expires_at)) => {
            let url = body.url.as_deref().unwrap_or("http://127.0.0.1:18790");
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
            | PairingError::NotConfirmed
            | PairingError::RegistrationRequired
            | PairingError::RegistrationMismatch
            | PairingError::InvalidProof,
        ) => pairing_error(StatusCode::INTERNAL_SERVER_ERROR, "pairing_refused"),
    }
}
