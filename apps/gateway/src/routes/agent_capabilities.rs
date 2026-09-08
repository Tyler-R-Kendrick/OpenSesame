//! A native operator approves one bounded launch, never an ambient agent secret.
use crate::{
    app_state::AppState,
    middleware::auth::require_operator,
    session_claims::{parse_principal, Assurance, CredentialKind, HostSessionClaims},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_claims::hash_secret;
use opensesame_domain::{OrganizationId, OrganizationRole};
use opensesame_storage::agent_capabilities::{AgentGrant, AgentLaunch};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;

pub const AUDIENCES: &[&str] = &[
    "urn:opensesame:agent:mcp-host",
    "urn:opensesame:agent:mcp-client",
];
pub const CAPABILITIES: &[&str] = &[
    "host.tasks.read",
    "host.tasks.create",
    "host.tasks.invoke",
    "host.tasks.terminate",
    "host.sync.read",
    "host.sync.write",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchRequest {
    principal_id: String,
    organization_id: String,
    client_id: String,
    audience: String,
    capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenRequest {
    launch_handle: String,
    client_id: String,
    audience: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeRequest {
    principal_id: String,
    organization_id: String,
}

pub fn refused() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"agent_authority_refused"})),
    )
        .into_response()
}

fn valid_client(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub async fn create(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LaunchRequest>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    let Some(principal) = parse_principal(&req.principal_id) else {
        return refused();
    };
    let Ok(org) = OrganizationId::parse(&req.organization_id) else {
        return refused();
    };
    if org.as_uuid().is_nil()
        || !valid_client(&req.client_id)
        || !AUDIENCES.contains(&req.audience.as_str())
        || req.capabilities.is_empty()
        || req.capabilities.len() > CAPABILITIES.len()
        || req
            .capabilities
            .iter()
            .any(|cap| !CAPABILITIES.contains(&cap.as_str()))
    {
        return refused();
    }
    let handle = random_secret();
    let digest = hash_secret(&handle);
    let principal = principal.to_string();
    let organization = org.to_string();
    let capabilities = serde_json::to_string(&req.capabilities).expect("string array");
    let launch = AgentLaunch {
        handle_digest: &digest,
        principal_id: &principal,
        organization_id: &organization,
        client_id: &req.client_id,
        audience: &req.audience,
        resource: &st.resource,
        capabilities_json: &capabilities,
        now: Utc::now().timestamp(),
    };
    match st.db.create_agent_launch(&launch).await {
        Ok(true)=>(StatusCode::CREATED,[("cache-control", "no-store")],Json(json!({"launch_handle":handle,"expires_in":300,"client_id":req.client_id,"audience":req.audience,"scope":req.capabilities}))).into_response(),
        _=>refused(),
    }
}

pub async fn token(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TokenRequest>,
) -> Response {
    if headers.contains_key("origin")
        || req.launch_handle.len() != 64
        || !req.launch_handle.bytes().all(|b| b.is_ascii_hexdigit())
        || !valid_client(&req.client_id)
        || !AUDIENCES.contains(&req.audience.as_str())
    {
        return refused();
    }
    let raw = random_secret();
    let now = Utc::now().timestamp();
    let result = st
        .db
        .exchange_agent_launch(
            &hash_secret(&req.launch_handle),
            &hash_secret(&raw),
            &req.client_id,
            &req.audience,
            &st.resource,
            now,
        )
        .await;
    let Ok(Some(grant)) = result else {
        return refused();
    };
    let Ok(scope) = serde_json::from_str::<Vec<String>>(&grant.capabilities_json) else {
        return refused();
    };
    ([("cache-control", "no-store")],Json(json!({"access_token":format!("agent-capability:{raw}"),"token_type":"Bearer","expires_in":300,"client_id":grant.client_id,"audience":grant.audience,"scope":scope}))).into_response()
}

pub async fn revoke(
    State(st): State<AppState>,
    Path(client): Path<String>,
    headers: HeaderMap,
    Json(req): Json<RevokeRequest>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    let Some(principal) = parse_principal(&req.principal_id) else {
        return refused();
    };
    let Ok(org) = OrganizationId::parse(&req.organization_id) else {
        return refused();
    };
    if !valid_client(&client) || org.as_uuid().is_nil() {
        return refused();
    }
    match st
        .db
        .revoke_agent_client(&principal.to_string(), &org.to_string(), &client)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => refused(),
    }
}

pub fn claims(grant: &AgentGrant) -> Option<HostSessionClaims> {
    let claims = HostSessionClaims {
        credential_kind: CredentialKind::AgentCapability,
        principal_id: parse_principal(&grant.principal_id)?,
        organization_id: OrganizationId::parse(&grant.organization_id).ok()?,
        organization_role: OrganizationRole::Member,
        client_id: grant.client_id.clone(),
        audience: grant.resource.clone(),
        assurance: Assurance::LocalUnverified,
        auth_time: DateTime::from_timestamp(grant.approved_at, 0)?,
        amr: vec!["native_agent_launch".into()],
        last_step_up_at: None,
        dpop_jkt: None,
        origin: None,
        capability_ceiling: serde_json::from_str(&grant.capabilities_json).ok()?,
        project_id: None,
        actor_id: None,
        credential_handle: None,
        issued_at: DateTime::from_timestamp(grant.issued_at, 0)?,
        expires_at: DateTime::from_timestamp(grant.expires_at, 0)?,
        local_session: false,
    };
    claims
        .valid_for(&grant.resource, Utc::now())
        .then_some(claims)
}
