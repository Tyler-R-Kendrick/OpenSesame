//! Pairing creates only owner-bound ciphertext-sync authority, never operator authority.
use crate::{
    app_state::AppState,
    browser_pairing_proof::{refusal, validate},
    middleware::auth::{require_operator, require_session},
    session_claims::{parse_principal, Assurance, CredentialKind, HostSessionClaims},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_claims::{generate_user_code, hash_low_entropy, hash_secret};
use opensesame_domain::{OrganizationId, OrganizationRole};
use opensesame_storage::browser_pairing::{BrowserGrant, NewBrowserPairing};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequest {
    capabilities: Vec<String>,
}

fn allowed_capabilities(capabilities: &[String]) -> bool {
    !capabilities.is_empty()
        && capabilities.len() <= 2
        && capabilities
            .iter()
            .all(|cap| matches!(cap.as_str(), "host.sync.read" | "host.sync.write"))
}

pub async fn create(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateRequest>,
) -> Response {
    if !allowed_capabilities(&req.capabilities) {
        return refusal("invalid_capability_ceiling");
    }
    let (origin, jkt) = match validate(
        &st,
        &headers,
        "POST",
        "/api/v1/browser-pairings",
        None,
        None,
    )
    .await
    {
        Ok(binding) => binding,
        Err(response) => return response,
    };
    let now = Utc::now().timestamp();
    let bucket = hash_secret(&format!("pairing-create:{origin}"));
    if !st
        .db
        .admit_browser_pairing_attempt(&bucket, now)
        .await
        .unwrap_or(false)
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"pairing_rate_limited"})),
        )
            .into_response();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let device_code = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let user_code = generate_user_code();
    let capabilities =
        serde_json::to_string(&req.capabilities).expect("string vector serialization");
    let user_digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", &user_code);
    let device_digest = hash_secret(&device_code);
    let created = st
        .db
        .create_browser_pairing(&NewBrowserPairing {
            id: &id,
            device_digest: &device_digest,
            user_code_digest: &user_digest,
            origin: &origin,
            dpop_jkt: &jkt,
            audience: &st.resource,
            capabilities_json: &capabilities,
            now,
        })
        .await
        .unwrap_or(false);
    if !created {
        return refusal("pairing_capacity");
    }
    Json(
        json!({"pairing_id":id,"device_code":device_code,"user_code":user_code,
        "verification_uri":format!("{}/pair",st.resource.trim_end_matches('/')),
        "expires_in":300,"interval":5}),
    )
    .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
    user_code: String,
    decision: Decision,
    principal_id: String,
    organization_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Decision {
    Approve,
    Deny,
}

pub async fn decision(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DecisionRequest>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    let Some(principal) = parse_principal(&req.principal_id) else {
        return refusal("invalid_pairing_decision");
    };
    let Ok(org) = OrganizationId::parse(&req.organization_id) else {
        return refusal("invalid_pairing_decision");
    };
    if org.as_uuid().is_nil() || req.user_code.len() > 32 {
        return refusal("invalid_pairing_decision");
    }
    let now = Utc::now().timestamp();
    if !st
        .db
        .admit_browser_pairing_attempt("pairing-decision", now)
        .await
        .unwrap_or(false)
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"pairing_rate_limited"})),
        )
            .into_response();
    }
    let digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", &req.user_code);
    let changed = st
        .db
        .decide_browser_pairing(
            &digest,
            &principal.to_string(),
            &org.to_string(),
            matches!(req.decision, Decision::Approve),
            now,
        )
        .await
        .unwrap_or(false);
    if !changed {
        return refusal("invalid_pairing_decision");
    }
    if matches!(req.decision, Decision::Approve)
        && opensesame_connection_broker::config_access::provision_native_role(
            st.db.pool(),
            &org,
            &principal,
            OrganizationRole::Member,
        )
        .await
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenRequest {
    device_code: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectRequest {
    user_code: String,
}

pub async fn inspect(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<InspectRequest>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    let now = Utc::now().timestamp();
    if req.user_code.len() > 32
        || !st
            .db
            .admit_browser_pairing_attempt("pairing-inspect", now)
            .await
            .unwrap_or(false)
    {
        return refusal("invalid_pairing_request");
    }
    let digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", &req.user_code);
    match st.db.inspect_browser_pairing(&digest, now).await {
        Ok(Some(view)) => Json(view).into_response(),
        _ => refusal("invalid_pairing_request"),
    }
}

pub async fn list(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (_, claims) = match require_session(&st, &headers) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match st
        .db
        .list_browser_clients(
            &claims.principal_id.to_string(),
            &claims.organization_id.to_string(),
        )
        .await
    {
        Ok(clients) => Json(json!({"clients":clients})).into_response(),
        _ => refusal("client_store_unavailable"),
    }
}

pub async fn token(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TokenRequest>,
) -> Response {
    if req.device_code.len() != 64 {
        return refusal("invalid_grant");
    }
    let (origin, jkt) = match validate(
        &st,
        &headers,
        "POST",
        "/api/v1/browser-pairings/token",
        None,
        None,
    )
    .await
    {
        Ok(binding) => binding,
        Err(response) => return response,
    };
    let access_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let grant = st
        .db
        .consume_browser_pairing(
            &hash_secret(&req.device_code),
            &origin,
            &jkt,
            &hash_secret(&access_token),
            Utc::now().timestamp(),
        )
        .await;
    let Ok(Some(grant)) = grant else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"authorization_pending"})),
        )
            .into_response();
    };
    Json(json!({"access_token":format!("opaque-session:{access_token}"),"token_type":"DPoP","expires_in":300,
        "client_id":grant.client_id,"scope":serde_json::from_str::<Vec<String>>(&grant.capabilities_json).unwrap_or_default().join(" ")})).into_response()
}

pub fn session_claims(grant: &BrowserGrant) -> Result<HostSessionClaims, Response> {
    let principal_id =
        parse_principal(&grant.principal_id).ok_or_else(|| refusal("invalid_grant"))?;
    let organization_id =
        OrganizationId::parse(&grant.organization_id).map_err(|_| refusal("invalid_grant"))?;
    let issued_at =
        DateTime::from_timestamp(grant.issued_at, 0).ok_or_else(|| refusal("invalid_grant"))?;
    let auth_time =
        DateTime::from_timestamp(grant.approved_at, 0).ok_or_else(|| refusal("invalid_grant"))?;
    let expires_at =
        DateTime::from_timestamp(grant.expires_at, 0).ok_or_else(|| refusal("invalid_grant"))?;
    let capability_ceiling = serde_json::from_str::<Vec<String>>(&grant.capabilities_json)
        .map_err(|_| refusal("invalid_grant"))?;
    if !allowed_capabilities(&capability_ceiling) {
        return Err(refusal("invalid_grant"));
    }
    let mut claims = HostSessionClaims {
        credential_kind: CredentialKind::BrowserGrant,
        principal_id,
        organization_id,
        organization_role: OrganizationRole::Member,
        client_id: grant.client_id.clone(),
        audience: grant.audience.clone(),
        assurance: Assurance::LocalUnverified,
        auth_time,
        amr: vec!["local_operator_approval".into()],
        last_step_up_at: None,
        dpop_jkt: Some(grant.dpop_jkt.clone()),
        origin: Some(grant.origin.clone()),
        capability_ceiling,
        project_id: None,
        actor_id: None,
        credential_handle: None,
        issued_at,
        expires_at,
        local_session: true,
    };
    if let Some(authentication) = &grant.authentication_json {
        let authentication: super::host_authorizations::BrowserAuthentication =
            serde_json::from_str(authentication).map_err(|_| refusal("invalid_grant"))?;
        claims.organization_role = authentication.role;
        claims.auth_time = DateTime::from_timestamp(authentication.auth_time, 0)
            .ok_or_else(|| refusal("invalid_grant"))?;
        claims.last_step_up_at = Some(claims.auth_time);
        claims.assurance = Assurance::PhishingResistant;
        claims.amr = vec!["webauthn".into()];
        claims.local_session = false;
        claims
            .capability_ceiling
            .extend(["host.agent.observe".into(), "host.agent.control".into()]);
        claims.capability_ceiling.extend(
            crate::middleware::browser_user_routes::CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned()),
        );
    }
    Ok(claims)
}

pub async fn revoke(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, claims) = match require_session(&st, &headers) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let result = st
        .db
        .revoke_browser_client(
            &id,
            &claims.principal_id.to_string(),
            &claims.organization_id.to_string(),
            Utc::now().timestamp(),
        )
        .await;
    if !matches!(result, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn instructions() -> axum::response::Html<&'static str> {
    axum::response::Html("<!doctype html><html lang=en><meta charset=utf-8><title>Pair a browser</title><h1>Approve on your local device</h1><p>Use the user code shown by the requesting browser in the authenticated local CLI. Check the exact origin and ciphertext-sync capabilities before approving. Never paste an operator credential into a web page.</p></html>")
}

pub fn routes() -> axum::Router<AppState> {
    use axum::{
        extract::DefaultBodyLimit,
        routing::{delete, get, post},
        Router,
    };
    Router::new()
        .route("/api/v1/browser-pairings", post(create))
        .route("/api/v1/browser-pairings/token", post(token))
        .route("/api/v1/browser-pairings/inspect", post(inspect))
        .route("/api/v1/browser-pairings/decision", post(decision))
        .route("/api/v1/browser-clients", get(list))
        .route("/api/v1/browser-clients/{id}", delete(revoke))
        .route("/pair", get(instructions))
        .layer(DefaultBodyLimit::max(4096))
}
