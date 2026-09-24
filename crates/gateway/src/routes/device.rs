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
use crate::middleware::auth::{require_demo_bootstrap, require_operator, same_principal_subject};

/// Failed `user_code` guesses tolerated across the whole instance per window.
///
/// A guess cannot be attributed to a particular pending authorization, so the
/// fence has to be global. It is a cooldown rather than an invalidation: a wrong
/// guess must never destroy in-flight device authorizations (that would let any
/// caller cancel every pending login).
const MAX_APPROVE_FAILURES: usize = 10;
const APPROVE_FAILURE_WINDOW_SECS: i64 = 60;
const MAX_PENDING_DEVICE_CODES: usize = 512;
const DEVICE_SCOPE: &str = "opensesame.session";

fn admitted_client(client_id: &str) -> bool {
    matches!(client_id, "opensesame-cli" | "opensesame-pages")
}

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
    if !admitted_client(&req.client_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unauthorized_client"})),
        )
            .into_response();
    }
    let scope = req.scope.unwrap_or_else(|| DEVICE_SCOPE.into());
    if scope != DEVICE_SCOPE {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_scope"})),
        )
            .into_response();
    }
    let now = Utc::now();
    {
        let mut map = st.device_codes.lock().unwrap();
        map.retain(|_, p| p.expires_at > now);
        if map.len() >= MAX_PENDING_DEVICE_CODES {
            let oldest_unapproved = map
                .iter()
                .filter(|(_, pending)| pending.approved.is_none())
                .min_by_key(|(_, pending)| pending.expires_at)
                .map(|(digest, _)| digest.clone());
            if let Some(digest) = oldest_unapproved {
                map.remove(&digest);
            } else {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"error":"device_code_capacity"})),
                )
                    .into_response();
            }
        }
        let device_code = format!("dc_{}", uuid::Uuid::new_v4());
        let user_code = opensesame_claims::generate_user_code();
        let expires_at = now + Duration::minutes(15);
        let device_digest = hash_secret(&device_code);
        map.insert(
            device_digest.clone(),
            crate::app_state::DevicePending {
                user_code_hash: user_code_digest(&st.claim_pepper, &device_digest, &user_code),
                client_id: req.client_id.clone(),
                scope: scope.clone(),
                expires_at,
                approved: None,
            },
        );
        drop(map);
        Json(json!({
            "device_code": device_code,
            "user_code": user_code,
            "verification_uri": format!("{}/device", st.resource),
            "verification_uri_complete": format!("{}/device?user_code={}", st.resource, user_code),
            "expires_in": 900,
            "interval": 5,
            "client_id": req.client_id,
            "scope": scope
        }))
        .into_response()
    }
}

#[derive(Deserialize)]
pub struct DeviceTokenRequest {
    device_code: String,
    client_id: String,
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
    // Membership mutations revoke approved grants and live sessions together.
    // Hold the same lifecycle fence until this grant is consumed and its session
    // is published, so revocation cannot slip between those two states.
    let _lifecycle = st.session_lifecycle.lock().unwrap();
    let device_code_hash = hash_secret(&req.device_code);
    let mut map = st.device_codes.lock().unwrap();
    let Some(pending) = map.get_mut(&device_code_hash) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    };
    if pending.client_id != req.client_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    }
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
    // Identity already supplied the trusted principal, organization, and role.
    // Demo bootstrap metadata is useful in development, but production disables
    // that bootstrap and must still be able to mint this organization session.
    let boot = st.bootstrap.lock().unwrap().clone().filter(|boot| {
        boot.org == approved.organization_id
            && same_principal_subject(&approved.principal, &boot.principal.to_string())
    });
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    // The session id *is* the bearer; only its digest is retained server-side.
    let session_digest = hash_secret(&session_id);
    let actor_id = boot.as_ref().map(|boot| boot.actor);
    let project_id = boot.as_ref().map(|boot| boot.project);
    let credential_handle = boot
        .as_ref()
        .map(|_| format!("handle_{}", uuid::Uuid::new_v4()));
    // Bind session to the *approved* principal — never the bootstrap demo id alone.
    let Some(principal) = crate::session_claims::parse_principal(&approved.principal) else {
        map.remove(&device_code_hash);
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response();
    };
    let mut claims = crate::session_claims::HostSessionClaims::operator_approved(
        principal,
        approved.organization_id,
        approved.organization_role,
        pending.client_id.clone(),
        st.resource.clone(),
    );
    claims.actor_id = actor_id;
    claims.project_id = project_id;
    claims.credential_handle = credential_handle;
    let meta = claims.public_view();
    {
        let mut sessions = st.sessions.lock().unwrap();
        let now = Utc::now();
        sessions.retain(|_, m| m.valid_for(&st.resource, now));
        if sessions.len() >= 1024 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"session_capacity"})),
            )
                .into_response();
        }
        sessions.insert(session_digest, claims);
    }
    map.remove(&device_code_hash);
    // Never return refresh token bytes — opaque handle only
    (
        StatusCode::OK,
        [("cache-control", "no-store")],
        Json(json!({
            "token_type": "Bearer",
            "expires_in": 300,
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

fn approved_organization(
    organization_id: Option<&str>,
    organization_role: Option<opensesame_domain::OrganizationRole>,
    operator_default: Option<opensesame_domain::OrganizationId>,
) -> Result<
    (
        opensesame_domain::OrganizationId,
        opensesame_domain::OrganizationRole,
    ),
    &'static str,
> {
    match (organization_id, organization_role) {
        (Some(id), Some(role)) => opensesame_domain::OrganizationId::parse(id)
            .map(|id| (id, role))
            .map_err(|_| "invalid_organization_id"),
        (None, None) => operator_default
            .map(|id| (id, opensesame_domain::OrganizationRole::Owner))
            .ok_or("demo_bootstrap_unavailable"),
        _ => Err("organization_claims_incomplete"),
    }
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
    let principal = req
        .principal
        .as_deref()
        .and_then(crate::session_claims::parse_principal);
    let organization = approved_organization(
        req.organization_id.as_deref(),
        req.organization_role,
        st.bootstrap.lock().unwrap().as_ref().map(|boot| boot.org),
    )
    .ok();
    let response = approve_native(&st, &headers, &req);
    if response.status().is_success() {
        if let (Some(principal), Some((org, role))) = (principal, organization) {
            if opensesame_connection_broker::config_access::provision_native_role(
                st.db.pool(),
                &org,
                &principal,
                role,
            )
            .await
            .is_err()
            {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
        }
    }
    response
}

fn approve_native(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    req: &DeviceApproveRequest,
) -> Response {
    if let Err(resp) = require_operator(st, headers) {
        return resp;
    }
    let now = Utc::now();
    // Hold the failure fence across the guess so concurrent misses cannot all
    // observe count < MAX and then all push.
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

    let mut map = st.device_codes.lock().unwrap();
    map.retain(|_, p| p.expires_at > now);
    // The digest is bound per device code, so the attempt is recomputed for each
    // candidate rather than compared against one global hash.
    for (device_digest, pending) in map.iter_mut() {
        let attempt_hash = user_code_digest(&st.claim_pepper, device_digest, &req.user_code);
        if hash_eq(&attempt_hash, &pending.user_code_hash) {
            drop(failures);
            let operator_default =
                if req.organization_id.is_none() && req.organization_role.is_none() {
                    match require_demo_bootstrap(st) {
                        Ok(boot) => Some(boot.org),
                        Err(resp) => return resp,
                    }
                } else {
                    None
                };
            let organization = match approved_organization(
                req.organization_id.as_deref(),
                req.organization_role,
                operator_default,
            ) {
                Ok(organization) => organization,
                Err(error) => {
                    return (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response();
                }
            };
            let Some(principal) = req
                .principal
                .as_deref()
                .and_then(crate::session_claims::parse_principal)
            else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"principal_required"})),
                )
                    .into_response();
            };
            pending.approved = Some(ApprovedDevice {
                principal: principal.to_string(),
                organization_id: organization.0,
                organization_role: organization.1,
            });
            return (
                StatusCode::OK,
                Json(json!({
                    "status":"approved",
                    "client_id": pending.client_id,
                    "scope": pending.scope,
                })),
            )
                .into_response();
        }
    }
    // A miss costs the guesser budget, not the pending authorizations.
    // Push while still holding `failures` — a second lock here deadlocks
    // `std::sync::Mutex` and lets concurrent misses all observe count < MAX.
    failures.push(now);
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"unknown_user_code"})),
    )
        .into_response()
}

#[cfg(test)]
#[path = "device_tests.rs"]
mod tests;
