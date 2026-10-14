use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::App;

pub(crate) fn origin_of(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::ORIGIN)?.to_str().ok()
}

pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

pub(crate) fn pairing_error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

pub(crate) fn require_paired_caller(st: &App, headers: &HeaderMap) -> Result<(), Response> {
    let Some(origin) = origin_of(headers) else {
        return Err(pairing_error(StatusCode::FORBIDDEN, "origin_required"));
    };
    let Some(token) = bearer(headers) else {
        return Err(pairing_error(
            StatusCode::UNAUTHORIZED,
            "cli_app_pairing_required",
        ));
    };
    let host = st.cli_app_integration.lock().map_err(|_| {
        pairing_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cli_app_integration_locked",
        )
    })?;
    if host.pairings.authorizes(token, origin) {
        Ok(())
    } else {
        Err(pairing_error(
            StatusCode::UNAUTHORIZED,
            "cli_app_pairing_required",
        ))
    }
}
