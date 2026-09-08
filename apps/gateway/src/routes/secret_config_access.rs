//! One authorization boundary for config metadata, key names and all aliases.
use crate::{
    app_state::AppState,
    middleware::auth::{parse_principal, Caller},
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{
    config_access::{self, PolicyActor, ResourcePermission},
    SecretConfigView,
};
use opensesame_domain::OrganizationId;
use serde_json::json;

pub(in crate::routes) fn hidden() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
}

#[allow(clippy::result_large_err)]
pub(in crate::routes) fn organization(
    st: &AppState,
    who: &Caller,
    headers: &HeaderMap,
) -> Result<OrganizationId, Response> {
    let selected = headers.get("x-opensesame-organization");
    match who {
        Caller::Operator => selected
            .and_then(|raw| raw.to_str().ok())
            .and_then(|value| {
                OrganizationId::parse(value)
                    .ok()
                    .filter(|id| id.to_string() == value)
            })
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"organization_selection_required"})),
                )
                    .into_response()
            }),
        Caller::Session { .. } if selected.is_some() => Err(hidden()),
        Caller::Session { .. } => Ok(who.organization(st.connection_organization)),
    }
}

#[allow(clippy::result_large_err)]
pub(in crate::routes) fn actor(who: &Caller) -> Result<PolicyActor, Response> {
    match who {
        Caller::Operator => Ok(PolicyActor::Operator),
        Caller::Session { subject, role, .. } => parse_principal(subject)
            .map(|principal| PolicyActor::Session {
                principal,
                role: *role,
            })
            .ok_or_else(hidden),
    }
}

pub(in crate::routes) async fn project(
    st: &AppState,
    who: &Caller,
    organization: &OrganizationId,
    project: &str,
    permission: ResourcePermission,
) -> Result<(), Response> {
    let actor = actor(who)?;
    match config_access::permits(st.db.pool(), organization, &actor, project, permission).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(hidden()),
        Err(_) => Err(StatusCode::SERVICE_UNAVAILABLE.into_response()),
    }
}

pub(super) async fn config(
    st: &AppState,
    who: &Caller,
    organization: &OrganizationId,
    id: &str,
    permission: ResourcePermission,
) -> Result<SecretConfigView, Response> {
    let view = st
        .connection_broker
        .get_secret_config_view(&organization.to_string(), id)
        .await
        .map_err(|_| hidden())?;
    project(st, who, organization, &view.project_id, permission).await?;
    Ok(view)
}
