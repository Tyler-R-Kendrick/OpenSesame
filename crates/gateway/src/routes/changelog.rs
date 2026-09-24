//! Host-readable secret/config changelog (metadata only).
//!
//! Lists project-scoped events from the durable `secret_changelog` table
//! (cursor-paged by `seq`; the in-memory ring is only a cache / fallback).
//! Never returns secret values — only key names, version ids, and sync
//! target metadata.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{is_allowed_changelog_event_type, RecordSecretChangelog};
use serde::Deserialize;
use serde_json::json;

use super::secret_configs::access;
use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;
use opensesame_connection_broker::config_access::ResourcePermission;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default = "default_limit")]
    limit: usize,
    /// Durable-store cursor: return rows with seq strictly below this.
    #[serde(default)]
    before_seq: Option<i64>,
}

fn default_limit() -> usize {
    50
}

/// `GET /api/v1/projects/{project_id}/changelog`
pub async fn list_for_project(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    if project_id.trim().is_empty() || project_id.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_project_id"})),
        )
            .into_response();
    }
    let organization = match access::organization(&st, &caller, &headers) {
        Ok(org) => org,
        Err(response) => return response,
    };
    if let Err(response) = access::project(
        &st,
        &caller,
        &organization,
        &project_id,
        ResourcePermission::Keys,
    )
    .await
    {
        return response;
    }
    let organization_id = organization.to_string();
    let limit = query.limit.clamp(1, 200);
    // Host-owned store: filter by the authenticated organization, never by a
    // caller-supplied project id across tenants.
    let events = match st
        .connection_broker
        .list_changelog(&organization_id, &project_id, limit, query.before_seq)
        .await
    {
        Ok(events) => events,
        Err(e) => return crate::routes::connections::broker_error(&e),
    };
    let next_cursor = events.iter().filter_map(|e| e.seq).min();
    (
        StatusCode::OK,
        Json(json!({
            "project_id": project_id,
            "events": events,
            "next_before_seq": next_cursor,
        })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct RecordBody {
    event_type: String,
    project_id: String,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    config_id: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    key_names: Vec<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    content_version: Option<String>,
    #[serde(default)]
    metadata: serde_json::Map<String, serde_json::Value>,
}

/// Operator/internal record endpoint for Host-plane changelog rows.
/// Agents must not use this to retrieve secrets — the body rejects values and
/// the response echoes redacted metadata only.
pub async fn record(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<RecordBody>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    if body.project_id.trim().is_empty() || body.event_type.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_body"})),
        )
            .into_response();
    }
    if !is_allowed_changelog_event_type(&body.event_type) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_event_type"})),
        )
            .into_response();
    }
    let organization = match access::organization(&st, &caller, &headers) {
        Ok(org) => org,
        Err(response) => return response,
    };
    if let Err(response) = access::project(
        &st,
        &caller,
        &organization,
        &body.project_id,
        ResourcePermission::Manage,
    )
    .await
    {
        return response;
    }
    let organization_id = organization.to_string();
    if let Some(claimed) = body.organization_id.as_deref() {
        if claimed != organization_id {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "forbidden"}))).into_response();
        }
    }
    let actor_id = match &caller {
        crate::middleware::auth::Caller::Operator => Some("operator".into()),
        crate::middleware::auth::Caller::Session { subject, .. } => Some(subject.clone()),
    };
    let entry = match st
        .connection_broker
        .record_changelog(RecordSecretChangelog {
            event_type: body.event_type,
            project_id: body.project_id,
            organization_id: Some(organization_id),
            actor_id,
            config_id: body.config_id,
            environment: body.environment,
            key_names: body.key_names,
            version_id: body.version_id,
            target_id: body.target_id,
            content_version: body.content_version,
            occurred_at: None,
            metadata: body.metadata,
        })
        .await
    {
        Ok(entry) => entry,
        Err(e) => return crate::routes::connections::broker_error(&e),
    };
    let serialized = serde_json::to_value(&entry).unwrap_or_else(|_| json!({}));
    (StatusCode::CREATED, Json(serialized)).into_response()
}

#[cfg(test)]
#[path = "changelog_tests.rs"]
mod tests;
