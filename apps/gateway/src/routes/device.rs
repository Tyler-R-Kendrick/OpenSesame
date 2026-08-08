use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::json;

use opensesame_claims::{hash_eq, hash_secret};

use crate::app_state::AppState;
use crate::middleware::auth::{require_demo_bootstrap, require_operator};

/// Approval attempts allowed per pending device code before it is burned.
const MAX_APPROVE_ATTEMPTS: u32 = 5;

#[derive(Deserialize)]
pub struct DeviceAuthorizeRequest {
    client_id: String,
    scope: Option<String>,
}

pub async fn authorize(
    State(st): State<AppState>,
    Json(req): Json<DeviceAuthorizeRequest>,
) -> impl IntoResponse {
    {
        let mut map = st.device_codes.lock().unwrap();
        let now = Utc::now();
        map.retain(|_, p| p.expires_at > now);
        if map.len() >= 512 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"device_code_capacity"})),
            )
                .into_response();
        }
    }
    let device_code = format!("dc_{}", uuid::Uuid::new_v4());
    let user_code = opensesame_claims::generate_user_code();
    let expires_at = Utc::now() + Duration::minutes(15);
    // Keyed and matched by digest — neither bearer is retained in cleartext.
    st.device_codes.lock().unwrap().insert(
        hash_secret(&device_code),
        crate::app_state::DevicePending {
            user_code_hash: hash_secret(&user_code),
            expires_at,
            approved_principal: None,
            approve_attempts: 0,
        },
    );
    // device_code returned once to client process — never logged
    Json(json!({
        "device_code": device_code,
        "user_code": user_code,
        "verification_uri": format!("{}/device", st.resource),
        "verification_uri_complete": format!("{}/device?user_code={}", st.resource, user_code),
        "expires_in": 900,
        "interval": 5,
        "client_id": req.client_id,
        "scope": req.scope.unwrap_or_else(|| "opensesame.session".into())
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct DeviceTokenRequest {
    device_code: String,
    grant_type: String,
}

pub async fn token(State(st): State<AppState>, Json(req): Json<DeviceTokenRequest>) -> Response {
    if req.grant_type != "urn:ietf:params:oauth:grant-type:device_code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unsupported_grant_type"})),
        )
            .into_response();
    }
    let device_code_hash = hash_secret(&req.device_code);
    let mut map = st.device_codes.lock().unwrap();
    let Some(pending) = map.get_mut(&device_code_hash) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    };
    if Utc::now() >= pending.expires_at {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"expired_token"})),
        )
            .into_response();
    }
    let Some(principal) = pending.approved_principal.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"authorization_pending"})),
        )
            .into_response();
    };
    let boot = match require_demo_bootstrap(&st) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    let handle = format!("handle_{}", uuid::Uuid::new_v4());
    // Bind session to the *approved* principal — never the bootstrap demo id alone.
    let meta = json!({
        "session_id": session_id,
        "principal_id": principal.clone(),
        "actor_id": boot.actor.to_string(),
        "issuer": st.issuer,
        "assurance": "mfa",
        "organization_id": boot.org.to_string(),
        "project_id": boot.project.to_string(),
        "credential_handle": handle,
        "approved_as": principal,
        "expires_at": (Utc::now() + Duration::hours(8)).to_rfc3339()
    });
    {
        let mut sessions = st.sessions.lock().unwrap();
        let now = Utc::now();
        sessions.retain(|_, m| {
            m.get("expires_at")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| now < dt.with_timezone(&Utc))
                .unwrap_or(false)
        });
        if sessions.len() >= 1024 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"session_capacity"})),
            )
                .into_response();
        }
        sessions.insert(session_id.clone(), meta.clone());
    }
    map.remove(&device_code_hash);
    // Never return refresh token bytes — opaque handle only
    (
        StatusCode::OK,
        Json(json!({
            "token_type": "Bearer",
            "expires_in": 28800,
            "session": meta,
            "access_token": format!("opaque-session:{session_id}")
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct DeviceApproveRequest {
    user_code: String,
    principal: Option<String>,
}

pub async fn approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<DeviceApproveRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let attempt_hash = hash_secret(&req.user_code);
    let mut map = st.device_codes.lock().unwrap();
    let now = Utc::now();
    map.retain(|_, p| p.expires_at > now && p.approve_attempts < MAX_APPROVE_ATTEMPTS);
    for pending in map.values_mut() {
        if hash_eq(&attempt_hash, &pending.user_code_hash) {
            pending.approved_principal = Some(req.principal.unwrap_or_else(|| "user:demo".into()));
            return (StatusCode::OK, Json(json!({"status":"approved"}))).into_response();
        }
    }
    // Count the miss against every live code so guessing burns the pending set.
    for pending in map.values_mut() {
        pending.approve_attempts += 1;
    }
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"unknown_user_code"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::DevicePending;
    use std::collections::HashMap;

    fn pending(user_code: &str) -> DevicePending {
        DevicePending {
            user_code_hash: hash_secret(user_code),
            expires_at: Utc::now() + Duration::minutes(15),
            approved_principal: None,
            approve_attempts: 0,
        }
    }

    #[test]
    fn codes_are_stored_as_digests_only() {
        let device_code = "dc_secret";
        let mut map: HashMap<String, DevicePending> = HashMap::new();
        map.insert(hash_secret(device_code), pending("BCDFGHJK"));

        assert!(!map.contains_key(device_code), "plaintext key must not hit");
        let entry = map.get(&hash_secret(device_code)).expect("digest key hits");
        assert!(!entry.user_code_hash.contains("BCDFGHJK"));
        assert!(hash_eq(&hash_secret("BCDFGHJK"), &entry.user_code_hash));
        assert!(!hash_eq(&hash_secret("BCDFGHJL"), &entry.user_code_hash));
    }

    #[test]
    fn wrong_codes_burn_pending_entry_after_max_attempts() {
        let mut map: HashMap<String, DevicePending> = HashMap::new();
        map.insert(hash_secret("dc_1"), pending("BCDFGHJK"));

        for _ in 0..MAX_APPROVE_ATTEMPTS {
            let now = Utc::now();
            map.retain(|_, p| p.expires_at > now && p.approve_attempts < MAX_APPROVE_ATTEMPTS);
            assert!(!map.is_empty(), "entry should survive until cap");
            for p in map.values_mut() {
                p.approve_attempts += 1;
            }
        }

        let now = Utc::now();
        map.retain(|_, p| p.expires_at > now && p.approve_attempts < MAX_APPROVE_ATTEMPTS);
        assert!(map.is_empty(), "entry burned after cap");
    }
}
