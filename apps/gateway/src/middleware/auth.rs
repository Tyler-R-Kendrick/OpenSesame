use crate::app_state::AppState;
use crate::config;
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

/// Requires an active opaque session token (`Authorization: Bearer opaque-session:…`).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn require_session(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(String, Value), Response> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(token) = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
    else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"Bearer opaque-session:<id> required"})),
        )
            .into_response());
    };
    let Some(session_id) = token.strip_prefix("opaque-session:") else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"expected opaque-session token"})),
        )
            .into_response());
    };
    let mut sessions = st.sessions.lock().unwrap();
    let Some(meta) = sessions.get(session_id).cloned() else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_session"})),
        )
            .into_response());
    };
    let expired = meta
        .get("expires_at")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| chrono::Utc::now() >= dt.with_timezone(&chrono::Utc))
        .unwrap_or(true);
    if expired {
        sessions.remove(session_id);
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"session_expired"})),
        )
            .into_response());
    }
    Ok((session_id.to_string(), meta))
}

pub fn session_subject(meta: &Value) -> String {
    meta.get("approved_as")
        .or_else(|| meta.get("principal_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("user:demo")
        .to_string()
}

/// Human/operator mutations: `X-OpenSesame-Operator` or `Authorization: Bearer operator:<token>`.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn require_operator(st: &AppState, headers: &axum::http::HeaderMap) -> Result<(), Response> {
    if st.operator_token.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"operator_token_unconfigured"})),
        )
            .into_response());
    }
    let from_header = headers
        .get("x-opensesame-operator")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let from_bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| {
            a.strip_prefix("Bearer operator:")
                .or_else(|| a.strip_prefix("bearer operator:"))
                .map(str::to_string)
        });
    let provided = from_header.or(from_bearer);
    match provided {
        Some(t) if config::constant_time_eq(&t, &st.operator_token) => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error":"operator_unauthorized",
                "hint":"X-OpenSesame-Operator or Bearer operator:<token> required"
            })),
        )
            .into_response()),
    }
}

#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn require_session_or_operator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(), Response> {
    if require_session(st, headers).is_ok() {
        return Ok(());
    }
    require_operator(st, headers)
}

/// Session subject when present; operator falls back to seeded `user:demo` (policy bootstrap).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn resolve_caller_subject(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<String, Response> {
    if let Ok((_, meta)) = require_session(st, headers) {
        return Ok(session_subject(&meta));
    }
    require_operator(st, headers)?;
    Ok("user:demo".into())
}

#[allow(clippy::result_large_err)]
pub fn require_demo_bootstrap(st: &AppState) -> Result<crate::app_state::Bootstrap, Response> {
    st.bootstrap
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"demo_bootstrap_unavailable","hint":"set OPENSESAME_DEV_BOOTSTRAP=true in non-production"})),
            )
                .into_response()
        })
}
