use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use opensesame_claims::{generate_claim_token, hash_eq, hash_secret};
use opensesame_domain::*;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_demo_bootstrap, require_operator};

#[derive(Deserialize)]
pub struct AgentIdentityRequest {
    instance_public_key_jwk: serde_json::Value,
    requested_grant_digest: String,
    organization_hint: Option<String>,
    project_hint: Option<String>,
}

pub async fn create_identity(
    State(st): State<AppState>,
    Json(req): Json<AgentIdentityRequest>,
) -> impl IntoResponse {
    // Evict expired claim sessions to bound memory / DoS surface.
    {
        let mut map = st.claims.lock().unwrap();
        let now = Utc::now();
        map.retain(|_, s| s.expires_at > now);
        if map.len() >= 256 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"claim_capacity","hint":"too many pending agent claims"})),
            )
                .into_response();
        }
    }
    let claim_token = generate_claim_token();
    let user_code = opensesame_claims::generate_user_code();
    let id = ClaimSessionId::new();
    let boot = require_demo_bootstrap(&st).ok();
    let org_hint = req
        .organization_hint
        .as_deref()
        .and_then(|s| OrganizationId::parse(s).ok())
        .or_else(|| boot.as_ref().map(|b| b.org));
    let project_hint = req
        .project_hint
        .as_deref()
        .and_then(|s| ProjectId::parse(s).ok())
        .or_else(|| boot.as_ref().map(|b| b.project));
    let session = ClaimSession {
        id,
        organization_hint: org_hint,
        project_hint,
        actor_id: ActorId::new(),
        actor_instance_id: ActorInstanceId::new(),
        client_id: None,
        operator_id: None,
        instance_public_key_jwk: req.instance_public_key_jwk,
        claim_token_hash: hash_secret(&claim_token),
        user_code_hash: Some(hash_secret(&user_code)),
        claim_attempt_token_hash: None,
        provider_assertion_digest: None,
        attestation_digest: None,
        requested_grant_digest: req.requested_grant_digest,
        state: ClaimState::Pending,
        created_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(15),
        claimed_at: None,
        claimed_by_principal_id: None,
    };
    let claim_id = session.id.to_string();
    st.claims.lock().unwrap().insert(claim_id.clone(), session);
    (
        StatusCode::OK,
        Json(json!({
            "claim_id": claim_id,
            "claim_token": claim_token,
            "user_code": user_code,
            "verification_uri": format!("{}/claim", st.resource),
            "expires_in": 900
        })),
    )
        .into_response()
}

pub async fn poll(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let map = st.claims.lock().unwrap();
    match map.get(&id) {
        Some(s) => Json(json!({"state": s.state, "claim_id": id})),
        None => Json(json!({"error":"not_found"})),
    }
}

#[derive(Deserialize)]
pub struct ClaimCompleteRequest {
    claim_token: String,
    narrow_actions: Option<Vec<String>>,
}

pub async fn complete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ClaimCompleteRequest>,
) -> Response {
    // Operator must approve — claim_token alone must not self-complete (agent cannot).
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let mut map = st.claims.lock().unwrap();
    let Some(session) = map.get_mut(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    if !hash_eq(&hash_secret(&req.claim_token), &session.claim_token_hash) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_claim_token"})),
        )
            .into_response();
    }
    if session.state != ClaimState::Pending {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"already_completed_or_invalid"})),
        )
            .into_response();
    }
    let boot = match require_demo_bootstrap(&st) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    // Claiming must not silently widen the requested grant.
    if let Some(actions) = &req.narrow_actions {
        let parent_actions = &boot.grant.actions;
        if actions.iter().any(|a| !parent_actions.iter().any(|p| p == a)) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"cannot_widen_grant"})),
            )
                .into_response();
        }
    }
    session.state = ClaimState::Claimed;
    session.claimed_at = Some(Utc::now());
    session.claimed_by_principal_id = Some(boot.principal);
    (
        StatusCode::OK,
        Json(json!({"state":"claimed","principal_id": boot.principal.to_string()})),
    )
        .into_response()
}
