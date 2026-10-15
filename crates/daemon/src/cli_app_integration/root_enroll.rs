//! HTTP for SPAKE2 root-trust enrollment.
//!
//! Begin is operator-authenticated and returns the one-time secret once.
//! Finish is authenticated by the PAKE. Neither route sits on the browser CORS
//! router. The secret is not logged and is not on the finish response.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine as _;
use opensesame_cli_app_integration::{
    RootEnrollError, RootEnrollFinish, RootEnrollRequest, ROOT_ENROLL_BEGIN_PATH,
    ROOT_ENROLL_FINISH_PATH,
};
use serde::Deserialize;
use serde_json::json;

use crate::{require_operator, App, UdsPeer};

use super::auth::pairing_error;
use super::now_unix;

const MAX_BODY: usize = 2048;

pub(crate) fn routes() -> Router<App> {
    Router::new()
        .route(ROOT_ENROLL_BEGIN_PATH, post(begin))
        .route(ROOT_ENROLL_FINISH_PATH, post(finish))
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

pub(crate) async fn begin(
    State(st): State<App>,
    headers: HeaderMap,
    uds: UdsPeer,
    _body: Bytes,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    if st.cli_root_trust_dir.is_none() {
        return pairing_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "root_trust_store_unavailable",
        );
    }
    let now = now_unix();
    let mut host = lock_host(&st);
    match host.begin_root_enroll(now) {
        Ok(begun) => Json(json!({
            "sessionId": begun.session_id,
            "enrollmentSecretB64": b64(begun.enrollment_secret.as_slice()),
            "messageB64": b64(&begun.daemon_message),
            "expiresAt": begun.expires_at,
        }))
        .into_response(),
        Err(_) => pairing_error(StatusCode::INTERNAL_SERVER_ERROR, "root_enroll_failed"),
    }
}

pub(crate) async fn finish(State(st): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if headers.contains_key(header::ORIGIN) {
        return pairing_error(StatusCode::FORBIDDEN, "origin_forbidden");
    }
    let Some(enroll_entry) = enroll_entry_from_headers(&headers) else {
        return pairing_error(StatusCode::FORBIDDEN, "root_enroll_refused");
    };
    let Some(dir) = st.cli_root_trust_dir.clone() else {
        return pairing_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "root_trust_store_unavailable",
        );
    };
    let Ok(parsed) = serde_json::from_slice::<FinishBody>(&body) else {
        return pairing_error(StatusCode::FORBIDDEN, "root_enroll_refused");
    };
    let decoded = match decode_finish(&parsed) {
        Ok(decoded) => decoded,
        Err(fail) => return decode_response(fail),
    };
    let now = now_unix();
    let mut host = lock_host(&st);
    let outcome = match host.finish_root_enroll(decoded.request(), now) {
        Ok(outcome) => outcome,
        Err(err) => return map_finish_error(err),
    };
    if let Err(err) = super::root_trust::save(&dir, &outcome.record) {
        tracing::warn!(%err, "cli root trust store write failed");
        return pairing_error(StatusCode::INTERNAL_SERVER_ERROR, "root_trust_store_failed");
    }
    enrolled_response(&mut host, outcome, enroll_entry)
}

fn enroll_entry_from_headers(headers: &HeaderMap) -> Option<&'static str> {
    let value = headers
        .get("x-opensesame-enroll-entry")
        .and_then(|v| v.to_str().ok())?;
    match value {
        "secure-prompt" => Some("secure-prompt"),
        "tty-opt-in" => Some("tty-opt-in"),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishBody {
    session_id: String,
    message_b64: String,
    confirm_b64: String,
    root_public_key_spki_b64: String,
}

struct DecodedFinish {
    session_id: String,
    message: Vec<u8>,
    confirm: Vec<u8>,
    spki: Vec<u8>,
}

impl DecodedFinish {
    fn request(&self) -> RootEnrollRequest<'_> {
        RootEnrollRequest {
            session_id: &self.session_id,
            client_message: &self.message,
            client_confirm: &self.confirm,
            root_spki_der: &self.spki,
        }
    }
}

enum DecodeFail {
    Unknown,
    Refused,
    BadSpki,
}

fn decode_finish(body: &FinishBody) -> Result<DecodedFinish, DecodeFail> {
    if !is_session_id(&body.session_id) {
        return Err(DecodeFail::Unknown);
    }
    let message = decode_b64(&body.message_b64).map_err(|()| DecodeFail::Refused)?;
    let confirm = decode_b64(&body.confirm_b64).map_err(|()| DecodeFail::Refused)?;
    if message.len() != 65 || confirm.len() != 32 {
        return Err(DecodeFail::Refused);
    }
    let spki = decode_b64(&body.root_public_key_spki_b64).map_err(|()| DecodeFail::BadSpki)?;
    if spki.is_empty() || spki.len() > 128 {
        return Err(DecodeFail::BadSpki);
    }
    Ok(DecodedFinish {
        session_id: body.session_id.clone(),
        message,
        confirm,
        spki,
    })
}

fn decode_response(fail: DecodeFail) -> Response {
    match fail {
        DecodeFail::Unknown => pairing_error(StatusCode::NOT_FOUND, "root_enroll_unknown"),
        DecodeFail::Refused => pairing_error(StatusCode::FORBIDDEN, "root_enroll_refused"),
        DecodeFail::BadSpki => pairing_error(StatusCode::BAD_REQUEST, "invalid_root_spki"),
    }
}

fn map_finish_error(err: RootEnrollError) -> Response {
    let (status, code) = match err {
        RootEnrollError::UnknownSession => (StatusCode::NOT_FOUND, "root_enroll_unknown"),
        RootEnrollError::Expired => (StatusCode::FORBIDDEN, "root_enroll_expired"),
        RootEnrollError::InvalidSpki => (StatusCode::BAD_REQUEST, "invalid_root_spki"),
        RootEnrollError::EpochExhausted => (StatusCode::CONFLICT, "root_enroll_epoch_exhausted"),
        RootEnrollError::InvalidSecret
        | RootEnrollError::InvalidMessage
        | RootEnrollError::InvalidConfirm => (StatusCode::FORBIDDEN, "root_enroll_refused"),
    };
    pairing_error(status, code)
}

fn enrolled_response(
    host: &mut opensesame_cli_app_integration::CliAppIntegrationHost,
    outcome: RootEnrollFinish,
    enroll_entry: &str,
) -> Response {
    let epoch = outcome.record.enrollment_epoch();
    let fingerprint = outcome.record.spki_fingerprint().to_string();
    let confirm = b64(&outcome.daemon_confirm);
    host.pairings.mark_root_key_enrolled(outcome.record);
    tracing::info!(
        epoch,
        enroll_entry,
        event = "cli_root_trust_enrolled",
        "cli root trust key enrolled via pake"
    );
    Json(json!({
        "enrolled": true,
        "spkiFingerprint": fingerprint,
        "enrollmentEpoch": epoch,
        "confirmB64": confirm,
    }))
    .into_response()
}

fn lock_host(
    st: &App,
) -> std::sync::MutexGuard<'_, opensesame_cli_app_integration::CliAppIntegrationHost> {
    match st.cli_app_integration.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_b64(value: &str) -> Result<Vec<u8>, ()> {
    let trimmed = value.trim();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(trimmed))
        .map_err(|_| ())
}

fn is_session_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
