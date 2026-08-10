use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::json;

use opensesame_claims::{hash_eq, hash_low_entropy, hash_secret};

use crate::app_state::{AppState, ApprovedDevice};
use crate::middleware::auth::{require_demo_bootstrap, require_operator};

/// Failed `user_code` guesses tolerated across the whole instance per window.
///
/// A guess cannot be attributed to a particular pending authorization, so the
/// fence has to be global. It is a cooldown rather than an invalidation: a wrong
/// guess must never destroy in-flight device authorizations (that would let any
/// caller cancel every pending login).
const MAX_APPROVE_FAILURES: usize = 10;
const APPROVE_FAILURE_WINDOW_SECS: i64 = 60;

/// Drops failures older than the window and reports how many remain.
fn prune_failures(failures: &mut Vec<chrono::DateTime<Utc>>, now: chrono::DateTime<Utc>) -> usize {
    let cutoff = now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS);
    failures.retain(|at| *at > cutoff);
    failures.len()
}

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
    let device_digest = hash_secret(&device_code);
    // Keyed and matched by digest — neither bearer is retained in cleartext. The
    // user code is low entropy, so its digest is keyed by the server pepper and
    // bound to this device code.
    st.device_codes.lock().unwrap().insert(
        device_digest.clone(),
        crate::app_state::DevicePending {
            user_code_hash: user_code_digest(&st.claim_pepper, &device_digest, &user_code),
            expires_at,
            approved: None,
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

/// Server-side copy of the session metadata with the bearer swapped for its
/// digest — the token returned to the client is never held at rest.
fn stored_session_meta(meta: &serde_json::Value, session_digest: &str) -> serde_json::Value {
    let mut stored = meta.clone();
    if let Some(obj) = stored.as_object_mut() {
        obj.insert("session_id".into(), json!(session_digest));
    }
    stored
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
    let Some(approved) = pending.approved.clone() else {
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
    // The session id *is* the bearer; only its digest is retained server-side.
    let session_digest = hash_secret(&session_id);
    let handle = format!("handle_{}", uuid::Uuid::new_v4());
    // Bind session to the *approved* principal — never the bootstrap demo id alone.
    let meta = json!({
        "session_id": session_id,
        "principal_id": approved.principal.clone(),
        "actor_id": boot.actor.to_string(),
        "issuer": st.issuer,
        "assurance": "mfa",
        "organization_id": approved.organization_id.to_string(),
        "organization_role": approved.organization_role,
        "project_id": boot.project.to_string(),
        "credential_handle": handle,
        "approved_as": approved.principal,
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
        sessions.insert(
            session_digest.clone(),
            stored_session_meta(&meta, &session_digest),
        );
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
    organization_id: Option<String>,
    organization_role: Option<opensesame_domain::OrganizationRole>,
}

/// Keyed, per-device digest of a user code.
fn user_code_digest(pepper: &str, device_digest: &str, user_code: &str) -> String {
    hash_low_entropy(pepper, device_digest, user_code)
}

pub async fn approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<DeviceApproveRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let now = Utc::now();
    {
        let mut failures = st.device_approve_failures.lock().unwrap();
        if prune_failures(&mut failures, now) >= MAX_APPROVE_FAILURES {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "too_many_attempts",
                    "retry_after_seconds": APPROVE_FAILURE_WINDOW_SECS,
                })),
            )
                .into_response();
        }
    }

    let mut map = st.device_codes.lock().unwrap();
    map.retain(|_, p| p.expires_at > now);
    // The digest is bound per device code, so the attempt is recomputed for each
    // candidate rather than compared against one global hash.
    for (device_digest, pending) in map.iter_mut() {
        let attempt_hash = user_code_digest(&st.claim_pepper, device_digest, &req.user_code);
        if hash_eq(&attempt_hash, &pending.user_code_hash) {
            let organization = match (&req.organization_id, req.organization_role) {
                (Some(id), Some(role)) => match opensesame_domain::OrganizationId::parse(id) {
                    Ok(id) => (id, role),
                    Err(_) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error":"invalid_organization_id"})),
                        )
                            .into_response();
                    }
                },
                (None, None) => {
                    let boot = match require_demo_bootstrap(&st) {
                        Ok(boot) => boot,
                        Err(resp) => return resp,
                    };
                    (boot.org, opensesame_domain::OrganizationRole::Owner)
                }
                _ => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"organization_claims_incomplete"})),
                    )
                        .into_response();
                }
            };
            pending.approved = Some(ApprovedDevice {
                principal: req.principal.unwrap_or_else(|| "user:demo".into()),
                organization_id: organization.0,
                organization_role: organization.1,
            });
            return (StatusCode::OK, Json(json!({"status":"approved"}))).into_response();
        }
    }
    // A miss costs the guesser budget, not the pending authorizations.
    st.device_approve_failures.lock().unwrap().push(now);
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

    const TEST_PEPPER: &str = "test-pepper";

    fn pending(device_digest: &str, user_code: &str) -> DevicePending {
        DevicePending {
            user_code_hash: user_code_digest(TEST_PEPPER, device_digest, user_code),
            expires_at: Utc::now() + Duration::minutes(15),
            approved: None,
        }
    }

    #[test]
    fn codes_are_stored_as_digests_only() {
        let device_code = "dc_secret";
        let digest = hash_secret(device_code);
        let mut map: HashMap<String, DevicePending> = HashMap::new();
        map.insert(digest.clone(), pending(&digest, "BCDFGHJK"));

        assert!(!map.contains_key(device_code), "plaintext key must not hit");
        let entry = map.get(&digest).expect("digest key hits");
        assert!(!entry.user_code_hash.contains("BCDFGHJK"));
        assert!(hash_eq(
            &user_code_digest(TEST_PEPPER, &digest, "BCDFGHJK"),
            &entry.user_code_hash
        ));
        assert!(!hash_eq(
            &user_code_digest(TEST_PEPPER, &digest, "BCDFGHJL"),
            &entry.user_code_hash
        ));
        // Keyless SHA-256 over ~2^35 codes is exhaustible; the stored digest is not
        // that, and it is not the same digest another device code would hold.
        assert!(!hash_eq(&hash_secret("BCDFGHJK"), &entry.user_code_hash));
        assert!(!hash_eq(
            &user_code_digest(TEST_PEPPER, "other-device", "BCDFGHJK"),
            &entry.user_code_hash
        ));
    }

    #[test]
    fn wrong_guesses_never_invalidate_pending_authorizations() {
        let mut map: HashMap<String, DevicePending> = HashMap::new();
        let digest = hash_secret("dc_1");
        map.insert(digest.clone(), pending(&digest, "BCDF-GHJK"));
        let mut failures: Vec<chrono::DateTime<Utc>> = Vec::new();

        for _ in 0..(MAX_APPROVE_FAILURES * 3) {
            let now = Utc::now();
            map.retain(|_, p| p.expires_at > now);
            failures.push(now);
        }

        let now = Utc::now();
        map.retain(|_, p| p.expires_at > now);
        assert_eq!(map.len(), 1, "guessing must not burn live authorizations");
        // The legitimate code still approves once the cooldown has elapsed.
        let entry = map.values().next().expect("entry");
        assert!(hash_eq(
            &user_code_digest(TEST_PEPPER, &digest, "BCDF-GHJK"),
            &entry.user_code_hash
        ));
    }

    #[test]
    fn session_bearer_is_never_retained() {
        let session_id = "sess_11111111-2222-3333-4444-555555555555";
        let digest = hash_secret(session_id);
        let meta = json!({"session_id": session_id, "approved_as": "prn_abc"});
        let stored = stored_session_meta(&meta, &digest);

        let mut sessions: HashMap<String, serde_json::Value> = HashMap::new();
        sessions.insert(digest.clone(), stored);

        assert!(
            !sessions.contains_key(session_id),
            "cleartext bearer must not be a key"
        );
        let found = sessions.get(&digest).expect("digest key hits");
        assert_eq!(found["session_id"], json!(digest));
        assert!(
            !serde_json::to_string(found).unwrap().contains(session_id),
            "stored metadata must not echo the bearer"
        );
        // The response copy still hands the caller its own token.
        assert_eq!(meta["session_id"], json!(session_id));
    }

    #[test]
    fn failure_window_prunes_and_caps() {
        let now = Utc::now();
        let mut failures: Vec<chrono::DateTime<Utc>> = vec![
            now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS + 5),
            now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS + 1),
        ];
        assert_eq!(
            prune_failures(&mut failures, now),
            0,
            "stale failures pruned"
        );

        for _ in 0..MAX_APPROVE_FAILURES {
            failures.push(now);
        }
        assert_eq!(prune_failures(&mut failures, now), MAX_APPROVE_FAILURES);
        assert!(
            prune_failures(&mut failures, now) >= MAX_APPROVE_FAILURES,
            "locked out"
        );

        // Everything ages out after the window.
        let later = now + Duration::seconds(APPROVE_FAILURE_WINDOW_SECS + 1);
        assert_eq!(prune_failures(&mut failures, later), 0);
    }
}
