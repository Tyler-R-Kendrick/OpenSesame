use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_connector_host::providers;
use opensesame_domain::{
    ConnectionId, ConnectionRecord, OrganizationId, OrganizationRole, ProjectId,
};
use opensesame_provider_openbao::CredentialAuthority;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{require_operator, require_session};

#[derive(Serialize)]
struct ConnectionView {
    id: ConnectionId,
    provider_id: String,
    display_name: String,
    public_config: Value,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
}

impl From<ConnectionRecord> for ConnectionView {
    fn from(value: ConnectionRecord) -> Self {
        Self {
            id: value.id,
            provider_id: value.provider_id,
            display_name: value.display_name,
            public_config: value.public_config,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Deserialize)]
pub struct CreateConnection {
    provider_id: String,
    display_name: String,
    #[serde(default = "empty_object")]
    public_config: Value,
}

#[derive(Deserialize)]
pub struct UpdateConnection {
    display_name: Option<String>,
    public_config: Option<Value>,
}

fn empty_object() -> Value {
    json!({})
}

fn session_scope(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(OrganizationId, Option<ProjectId>, OrganizationRole), Response> {
    let (_, meta) = require_session(st, headers)?;
    scope_from_meta(&meta).ok_or_else(unscoped_session)
}

fn scope_from_meta(meta: &Value) -> Option<(OrganizationId, Option<ProjectId>, OrganizationRole)> {
    let organization = meta
        .get("organization_id")
        .and_then(Value::as_str)
        .and_then(|id| OrganizationId::parse(id).ok())?;
    let project = meta
        .get("project_id")
        .and_then(Value::as_str)
        .map(ProjectId::parse)
        .transpose()
        .ok()?;
    let role = serde_json::from_value(meta.get("organization_role")?.clone()).ok()?;
    Some((organization, project, role))
}

fn require_configuration_role(role: OrganizationRole) -> Result<(), Response> {
    if role.can_configure_integrations() {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error": "forbidden", "detail": "owner or admin role required"})),
        )
            .into_response())
    }
}

pub async fn catalog() -> Json<Value> {
    Json(json!({
        "providers": providers::catalog(),
        "support_policy": "supported requires contract and live-test evidence"
    }))
}

pub async fn list(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let (organization, _, _) = match session_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    match st.db.list_connections(&organization).await {
        Ok(records) => Json(json!({
            "connections": records.into_iter().map(ConnectionView::from).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(error) => server_error(error),
    }
}

pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateConnection>,
) -> Response {
    let (organization, project, role) = match session_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    if let Err(response) = require_configuration_role(role) {
        return response;
    }
    let Some(provider) = providers::find(&body.provider_id) else {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "unknown_provider"})),
        )
            .into_response();
    };
    if body.display_name.trim().is_empty() || body.display_name.len() > 120 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "invalid_display_name"})),
        )
            .into_response();
    }
    let now = Utc::now();
    let connection = ConnectionRecord {
        id: ConnectionId::new(),
        organization_id: organization,
        project_id: project,
        provider_id: provider.id,
        display_name: body.display_name.trim().into(),
        public_config: body.public_config,
        credential_ref: None,
        created_at: now,
        updated_at: now,
    };
    if let Err(error) = connection.assert_public_config_safe() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "unsafe_public_config", "detail": error})),
        )
            .into_response();
    }
    match st.db.insert_connection(&connection).await {
        Ok(()) => (StatusCode::CREATED, Json(ConnectionView::from(connection))).into_response(),
        Err(error) => server_error(error),
    }
}

pub async fn update(
    State(st): State<AppState>,
    Path(raw_id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<UpdateConnection>,
) -> Response {
    let (organization, _, role) = match session_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    if let Err(response) = require_configuration_role(role) {
        return response;
    }
    let id = match ConnectionId::parse(&raw_id) {
        Ok(id) => id,
        Err(_) => return invalid_id(),
    };
    let mut connection = match st.db.get_connection(&organization, &id).await {
        Ok(Some(connection)) => connection,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return server_error(error),
    };
    if let Some(display_name) = body.display_name {
        if display_name.trim().is_empty() || display_name.len() > 120 {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({"error": "invalid_display_name"})),
            )
                .into_response();
        }
        connection.display_name = display_name.trim().into();
    }
    if let Some(public_config) = body.public_config {
        connection.public_config = public_config;
    }
    connection.updated_at = Utc::now();
    if let Err(error) = connection.assert_public_config_safe() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "unsafe_public_config", "detail": error})),
        )
            .into_response();
    }
    match st.db.update_connection(&connection).await {
        Ok(true) => Json(ConnectionView::from(connection)).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => server_error(error),
    }
}

pub async fn delete(
    State(st): State<AppState>,
    Path(raw_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let (organization, _, role) = match session_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    if let Err(response) = require_configuration_role(role) {
        return response;
    }
    let id = match ConnectionId::parse(&raw_id) {
        Ok(id) => id,
        Err(_) => return invalid_id(),
    };
    match st.db.delete_connection(&organization, &id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => server_error(error),
    }
}

pub async fn test_provider(
    State(st): State<AppState>,
    Path(provider_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    let Some(provider) = providers::find(&provider_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if provider.id == "openbao" {
        let Some(authority) = &st.openbao else {
            return Json(
                json!({"available": false, "live": false, "detail": "OpenBao is not configured"}),
            )
            .into_response();
        };
        return match authority.health().await {
            Ok(health) => Json(json!({
                "available": true,
                "live": true,
                "detail": {"sealed": health.sealed, "quorum_ok": health.quorum_ok}
            }))
            .into_response(),
            Err(_error) => {
                Json(json!({"available": false, "live": false, "detail": "openbao_unreachable"}))
                    .into_response()
            }
        };
    }
    match tokio::task::spawn_blocking(move || providers::probe_live(&provider)).await {
        Ok(probe) => Json(json!(probe)).into_response(),
        Err(error) => server_error(error.into()),
    }
}

fn invalid_id() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": "invalid_connection_id"})),
    )
        .into_response()
}

fn unscoped_session() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "session_scope_required"})),
    )
        .into_response()
}

fn server_error(error: anyhow::Error) -> Response {
    tracing::error!(error = %error, "connection storage failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "connection_storage_failed"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_scope_comes_from_the_session_not_demo_state() {
        let organization = OrganizationId::new();
        let project = ProjectId::new();
        assert_eq!(
            scope_from_meta(&json!({
                "organization_id": organization,
                "project_id": project,
                "organization_role": "admin",
            })),
            Some((organization, Some(project), OrganizationRole::Admin))
        );
        assert!(scope_from_meta(&json!({"approved_as": "user:demo"})).is_none());
    }

    #[test]
    fn only_owner_and_admin_can_mutate_provider_connections() {
        assert!(require_configuration_role(OrganizationRole::Owner).is_ok());
        assert!(require_configuration_role(OrganizationRole::Admin).is_ok());
        assert!(require_configuration_role(OrganizationRole::Member).is_err());
    }

    #[tokio::test]
    async fn members_can_list_but_only_admins_can_configure() {
        let state = crate::app_state::test_demo_state().await;
        let organization = OrganizationId::new();
        let member = crate::app_state::test_session_headers(
            &state,
            "prn_member",
            organization,
            OrganizationRole::Member,
        );
        let admin = crate::app_state::test_session_headers(
            &state,
            "prn_admin",
            organization,
            OrganizationRole::Admin,
        );
        let body = || {
            Json(CreateConnection {
                provider_id: "bitwarden".into(),
                display_name: "Bitwarden primary".into(),
                public_config: json!({}),
            })
        };

        assert_eq!(
            create(State(state.clone()), member.clone(), body())
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            create(State(state.clone()), admin, body()).await.status(),
            StatusCode::CREATED
        );
        assert_eq!(list(State(state), member).await.status(), StatusCode::OK);
    }
}
