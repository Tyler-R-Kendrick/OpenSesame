use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::app_state::AppState;
use crate::middleware::auth::{
    require_demo_bootstrap, require_operator, require_session, require_session_or_operator,
    same_principal_subject,
};
use crate::session_claims::HostSessionClaims;

pub async fn status(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let n = st.sessions.lock().unwrap().len();
    Json(json!({"active_sessions": n})).into_response()
}

/// Explicit operator-only local development session. Browsers use pairing.
pub async fn local_mint(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    if st.deployment.production_safeguards() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "local_session_forbidden",
                "hint": "Host-local sessions are disabled in production. Use Identity device approval."
            })),
        )
            .into_response();
    }
    let boot = match require_demo_bootstrap(&st) {
        Ok(boot) => boot,
        Err(resp) => return resp,
    };

    if opensesame_connection_broker::config_access::provision_native_role(
        st.db.pool(),
        &boot.org,
        &boot.principal,
        opensesame_domain::OrganizationRole::Owner,
    )
    .await
    .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let _lifecycle = st.session_lifecycle.lock().unwrap();
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    let session_digest = opensesame_claims::hash_secret(&session_id);
    let mut claims = HostSessionClaims::operator_approved(
        boot.principal,
        boot.org,
        opensesame_domain::OrganizationRole::Owner,
        "opensesame-cli".into(),
        st.resource.clone(),
    );
    claims.actor_id = Some(boot.actor);
    claims.project_id = Some(boot.project);
    claims.credential_handle = Some(format!("handle_{}", uuid::Uuid::new_v4()));
    claims.local_session = true;
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

    (
        StatusCode::OK,
        [("cache-control", "no-store")],
        Json(json!({
            "token_type": "Bearer",
            "expires_in": 300,
            "session": meta,
            "access_token": format!("opaque-session:{session_id}"),
            "local_session": true,
        })),
    )
        .into_response()
}

pub async fn whoami(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Ok((_, claims)) = require_session(&st, &headers) {
        return Json(claims.public_view()).into_response();
    }
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    Json(json!({"authentication":"operator", "assurance":"local_unverified", "issuer":st.issuer}))
        .into_response()
}

#[derive(Deserialize)]
pub struct RevokeSessionsRequest {
    principal_id: String,
    organization_id: String,
}

fn revoke_matching_sessions(
    sessions: &mut HashMap<String, HostSessionClaims>,
    principal_id: &str,
    organization_id: &str,
) -> usize {
    let before = sessions.len();
    sessions.retain(|_, meta| {
        !same_principal_subject(&meta.principal_id.to_string(), principal_id)
            || meta.organization_id.to_string() != organization_id
    });
    before - sessions.len()
}

fn revoke_pending_authorizations(
    pending: &mut HashMap<String, crate::app_state::DevicePending>,
    principal_id: &str,
    organization_id: opensesame_domain::OrganizationId,
) -> usize {
    let mut revoked = 0;
    for authorization in pending.values_mut() {
        if authorization.approved.as_ref().is_some_and(|approved| {
            same_principal_subject(&approved.principal, principal_id)
                && approved.organization_id == organization_id
        }) {
            authorization.approved = None;
            revoked += 1;
        }
    }
    revoked
}

pub async fn revoke(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RevokeSessionsRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let Ok(organization_id) = opensesame_domain::OrganizationId::parse(&req.organization_id) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_organization_id"})),
        )
            .into_response();
    };
    let canonical_organization_id = organization_id.to_string();
    // Device-token minting holds this fence from reading its approval through
    // publishing the session. Revocation therefore observes and clears either
    // the pending grant or the minted session, never a gap between them.
    let _lifecycle = st.session_lifecycle.lock().unwrap();
    let mut sessions = st.sessions.lock().unwrap();
    let revoked =
        revoke_matching_sessions(&mut sessions, &req.principal_id, &canonical_organization_id);
    drop(sessions);

    // An approved device code can mint a session after this request. Clear matching
    // approvals too so a membership mutation revokes both live and not-yet-minted sessions.
    revoke_pending_authorizations(
        &mut st.device_codes.lock().unwrap(),
        &req.principal_id,
        organization_id,
    );

    Json(json!({"revoked": revoked})).into_response()
}

#[cfg(test)]
pub fn list_connections(State(st): State<AppState>, headers: &axum::http::HeaderMap) -> Response {
    let caller = match crate::middleware::auth::resolve_caller(&st, headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let Some(connection_ref) = &st.connection_ref else {
        return Json(json!({"connections": []})).into_response();
    };
    let boot = match require_demo_bootstrap(&st) {
        Ok(boot) => boot,
        Err(resp) => return resp,
    };
    if !caller.in_organization(&boot.org) {
        return Json(json!({"connections": []})).into_response();
    }
    Json(json!({
        "connections": [{
            "connection_ref": connection_ref.handle.uri(),
            "connection_id": connection_ref.connection_id.to_string(),
            "logical_name": connection_ref.handle.logical_name,
            "max_invoke_level": 2,
            "operations": ["repository.read", "pull_request.create"]
        }]
    }))
    .into_response()
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
