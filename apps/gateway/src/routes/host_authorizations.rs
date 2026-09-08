//! Human verification authorizes one immutable Host request, never an operator session.
use crate::{
    app_state::AppState,
    browser_pairing_proof::refusal,
    middleware::auth::require_session,
    session_claims::{Assurance, CredentialKind, HostSessionClaims},
};
use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_claims::hash_secret;
use opensesame_storage::host_authorizations::HostAuthorization;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest {
    operation: String,
    target_id: String,
    transition: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRequest {
    challenge_id: String,
    assertion: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserAuthentication {
    pub role: opensesame_domain::OrganizationRole,
    pub auth_time: i64,
}

pub fn browser_claims(st: &AppState, headers: &HeaderMap) -> Result<HostSessionClaims, Response> {
    let (_, claims) = require_session(st, headers)?;
    if claims.credential_kind != CredentialKind::BrowserGrant {
        return Err(refusal("paired_browser_required"));
    }
    Ok(claims)
}

pub async fn challenge(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChallengeRequest>,
) -> Response {
    if st.host_authorization.is_none() {
        return refusal("host_authorization_unconfigured");
    }
    let claims = match browser_claims(&st, &headers) {
        Ok(claims) => claims,
        Err(error) => return error,
    };
    if req.target_id.is_empty() || req.target_id.len() > 128 {
        return refusal("invalid_authorization_purpose");
    }
    let version = match req.operation.as_str() {
        "browser.authenticate" if req.target_id == claims.client_id && req.transition.is_none() => {
            None
        }
        "agent.browser.control"
            if matches!(
                req.transition.as_deref(),
                Some("handoff" | "take" | "release")
            ) =>
        {
            if claims.assurance != Assurance::PhishingResistant {
                return refusal("identity_authentication_required");
            }
            let Ok(Some(run)) = st
                .db
                .get_observation_run(&claims.organization_id.to_string(), &req.target_id)
                .await
            else {
                return refusal("not_found");
            };
            if crate::session_claims::parse_principal(&run.owner_principal_id)
                != Some(claims.principal_id)
                || run.closed_at.is_some()
            {
                return refusal("not_found");
            }
            Some(run.version)
        }
        _ => return refusal("invalid_authorization_purpose"),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let expiry = (Utc::now().timestamp() + 300).min(claims.expires_at.timestamp());
    let digest = hash_secret(
        &json!([
            "host-authorization-v1",
            id,
            claims.client_id,
            claims.principal_id.to_string(),
            claims.organization_id.to_string(),
            st.resource,
            claims.origin,
            claims.dpop_jkt,
            req.operation,
            req.target_id,
            req.transition,
            version,
            expiry
        ])
        .to_string(),
    );
    let pending = HostAuthorization {
        id,
        client_id: claims.client_id,
        digest,
        operation: req.operation,
        target_id: req.target_id,
        transition: req.transition,
        run_version: version,
        expires_at: expiry,
    };
    if !st
        .db
        .create_host_authorization(&pending, Utc::now().timestamp())
        .await
        .unwrap_or(false)
    {
        return refusal("authorization_capacity");
    }
    Json(json!({"challenge_id":pending.id,"challenge_digest":pending.digest,"host_audience":st.resource,
        "organization_id":claims.organization_id.to_string(),"operation":pending.operation,"target_id":pending.target_id,
        "transition":pending.transition,"origin":claims.origin,"dpop_jkt":claims.dpop_jkt,"expires_at":expiry})).into_response()
}

pub async fn authorize(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EvidenceRequest>,
) -> Response {
    let Some(verifier) = &st.host_authorization else {
        return refusal("host_authorization_unconfigured");
    };
    let claims = match browser_claims(&st, &headers) {
        Ok(claims) => claims,
        Err(error) => return error,
    };
    let now = Utc::now().timestamp();
    let evidence = match verifier.verify(&req.assertion, &st.resource, now) {
        Ok(evidence) => evidence,
        Err(error) => return refusal(error),
    };
    let Ok(Some(pending)) = st
        .db
        .host_authorization(&req.challenge_id, &claims.client_id, now)
        .await
    else {
        return refusal("invalid_host_authorization");
    };
    if evidence.challenge_id != pending.id
        || evidence.challenge_digest != pending.digest
        || evidence.expires_at != pending.expires_at
        || evidence.operation != pending.operation
        || evidence.target_id != pending.target_id
        || evidence.transition != pending.transition
        || evidence.origin != claims.origin.as_deref().unwrap_or("")
        || evidence.dpop_jkt != claims.dpop_jkt.as_deref().unwrap_or("")
        || crate::session_claims::parse_principal(&evidence.sub) != Some(claims.principal_id)
        || evidence.organization_id != claims.organization_id.to_string()
    {
        return refusal("invalid_host_authorization");
    }
    let authentication = (pending.operation == "browser.authenticate")
        .then(|| {
            serde_json::to_string(&BrowserAuthentication {
                role: evidence.organization_role,
                auth_time: evidence.auth_time,
            })
        })
        .transpose();
    let Ok(authentication) = authentication else {
        return refusal("invalid_host_authorization");
    };
    let elevation = authentication.is_none().then(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    });
    let elevation_digest = elevation.as_deref().map(hash_secret);
    // Domain-separated JTI digest permits signing-key rotation without replay namespace drift.
    let jti = hash_secret(&format!(
        "host-evidence-v1:{}:{}",
        evidence.iss, evidence.jti
    ));
    if !st
        .db
        .authorize_host_challenge(
            &pending,
            &jti,
            authentication.as_deref(),
            elevation_digest.as_deref(),
            now,
        )
        .await
        .unwrap_or(false)
    {
        return refusal("invalid_host_authorization");
    }
    Json(json!({"status":"authorized","elevation":elevation,"expires_at":pending.expires_at}))
        .into_response()
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::post;
    axum::Router::new()
        .route("/api/v1/host-authorizations", post(challenge))
        .route("/api/v1/host-authorizations/verify", post(authorize))
        .layer(axum::extract::DefaultBodyLimit::max(20000))
}
