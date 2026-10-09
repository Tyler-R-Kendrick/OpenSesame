//! Human policy-management routes. Never included in agent capability ceilings.
use super::secret_configs::access;

/// The UI may hide controls, but every data/mutation route repeats this policy.
pub async fn get_project(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(project): Path<String>,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let org = match access::organization(&st, &who, &headers) {
        Ok(org) => org,
        Err(response) => return response,
    };
    let actor = match access::actor(&who) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let mut capabilities = Vec::new();
    for (permission, name) in [
        (
            config_access::ResourcePermission::Metadata,
            "config.metadata.read",
        ),
        (config_access::ResourcePermission::Keys, "config.keys.read"),
        (config_access::ResourcePermission::Manage, "config.manage"),
    ] {
        match config_access::permits(st.db.pool(), &org, &actor, &project, permission).await {
            Ok(true) => capabilities.push(name),
            Ok(false) => {}
            Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        }
    }
    if capabilities.is_empty() {
        return access::hidden();
    }
    Json(json!({"capabilities":capabilities})).into_response()
}
use crate::{
    app_state::AppState,
    middleware::auth::{resolve_caller, Caller},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::config_access::{self, ProjectAccess};
use opensesame_domain::{OrganizationRole, PrincipalId};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleUpdate {
    pub role: Option<OrganizationRole>,
    pub expected_revision: u64,
}

pub async fn get_role(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, principal)): Path<(String, String)>,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    if !matches!(who, Caller::Operator) {
        return access::hidden();
    }
    let org = match access::organization(&st, &who, &headers) {
        Ok(org) if org.to_string() == organization => org,
        _ => return access::hidden(),
    };
    let Ok(principal) = PrincipalId::parse(&principal) else {
        return access::hidden();
    };
    match config_access::role_policy(st.db.pool(), &org, &principal).await {
        Ok(Some(policy)) => Json(policy).into_response(),
        Ok(None) => access::hidden(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// Explicit native operator grant/revoke; sessions cannot raise their ceiling.
pub async fn set_role(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, principal)): Path<(String, String)>,
    Json(body): Json<RoleUpdate>,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    if !matches!(who, Caller::Operator) {
        return access::hidden();
    }
    let org = match access::organization(&st, &who, &headers) {
        Ok(org) if org.to_string() == organization => org,
        _ => return access::hidden(),
    };
    let Ok(principal) = PrincipalId::parse(&principal) else {
        return access::hidden();
    };
    match config_access::set_role_ceiling(
        st.db.pool(),
        &org,
        &principal,
        body.role,
        body.expected_revision,
        chrono::Utc::now().timestamp(),
    )
    .await
    {
        Ok(revision) => Json(json!({"revision":revision})).into_response(),
        Err(_) => (
            StatusCode::CONFLICT,
            Json(json!({"error":"policy_revision_conflict"})),
        )
            .into_response(),
    }
}

/// Current owner/admin grants or revokes the two independent project capabilities.
pub async fn set_project(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((project, principal)): Path<(String, String)>,
    Json(body): Json<ProjectAccess>,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let org = match access::organization(&st, &who, &headers) {
        Ok(org) => org,
        Err(response) => return response,
    };
    let actor = match access::actor(&who) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Ok(principal) = PrincipalId::parse(&principal) else {
        return access::hidden();
    };
    match config_access::set_project_access(st.db.pool(), &org, &actor, &project, &principal, body)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => access::hidden(),
    }
}
