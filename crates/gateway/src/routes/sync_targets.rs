//! Sync target routes (WP-C / ADR 0041).
//!
//! Create / list / delete / sync fan-out. Responses never include secret values.
//! Bus events (`sync.target.*`) publish via the injected [`TaskBus`].

#[path = "sync_targets_access.rs"]
mod access;

pub use access::{create, delete, get};

#[cfg(test)]
use crate::test_principals::P06;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
#[cfg(test)]
use opensesame_connection_broker::CreateSyncTarget;
use opensesame_connection_broker::{
    config_access::ResourcePermission, KeyFilteredSecretSource, SyncSecretSource,
};
use opensesame_domain::OrganizationId;
use opensesame_task_bus::BusEvent;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};
use crate::routes::connections::broker_error;
use crate::routes::secret_configs::access as secret_config_access;

#[allow(clippy::result_large_err)]
fn authorize(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to configure sync targets"
            })),
        )
            .into_response());
    }
    // Reject a malformed principal even for an empty collection.
    secret_config_access::actor(&who)?;
    Ok(who)
}

fn caller_organization(
    st: &AppState,
    who: &Caller,
    headers: &axum::http::HeaderMap,
) -> Result<OrganizationId, Response> {
    resolve_caller_organization(st, who, headers)
}

macro_rules! organization_or_return {
    ($st:expr, $who:expr, $headers:expr) => {
        match caller_organization($st, $who, $headers) {
            Ok(organization_id) => organization_id,
            Err(response) => return response,
        }
    };
}

#[derive(Debug, Deserialize, Default)]
pub struct ListQuery {
    pub project_id: Option<String>,
    pub config_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CreateBody {
    pub project_id: String,
    pub config_id: String,
    pub connection_id: String,
    pub operation: Option<String>,
}

/// Sync body: key **names** only on the wire — an optional filter over the
/// config's stored key set. Values resolve on Host through the ADR 0052
/// project-config store; clients can never supply values on this API.
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SyncBody {
    #[serde(default)]
    pub key_names: Vec<String>,
}

fn assert_no_secret_fields(value: &serde_json::Value) -> Result<(), Response> {
    let text = value.to_string().to_ascii_lowercase();
    for leak in [
        "\"access_token\"",
        "\"refresh_token\"",
        "\"client_secret\"",
        "\"code_verifier\"",
        "\"password\"",
    ] {
        if text.contains(leak) {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "internal_error",
                    "hint": "sync response refused: credential-shaped field"
                })),
            )
                .into_response());
        }
    }
    Ok(())
}

async fn publish_sync_bus(
    st: &AppState,
    event_type: &str,
    data: serde_json::Value,
) -> Result<(), Response> {
    let event = BusEvent::cloud_event(
        uuid::Uuid::now_v7().to_string(),
        "opensesame/gateway/sync-targets",
        event_type,
        chrono::Utc::now().to_rfc3339(),
        data,
    );
    st.task_bus.read().await.publish(event).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "bus_publish_failed", "hint": e.to_string()})),
        )
            .into_response()
    })
}

/// Bind the production source to caller identity, not to a cached allow.
/// Every load (including each fan-out target) rechecks the live Keys ceiling.
#[allow(clippy::result_large_err)]
fn secret_source_from_body(
    st: &AppState,
    who: &Caller,
    organization: &OrganizationId,
    body: &SyncBody,
) -> Result<Arc<dyn SyncSecretSource>, Response> {
    let actor = secret_config_access::actor(who)?;
    let inner = st
        .connection_broker
        .sync_secret_source()
        .map_err(|error| broker_error(&error))?;
    let source: Arc<dyn SyncSecretSource> = Arc::new(access::CallerSecretSource::new(
        st.db.pool().clone(),
        *organization,
        actor,
        inner,
    ));
    if body.key_names.is_empty() {
        Ok(source)
    } else {
        Ok(Arc::new(KeyFilteredSecretSource::new(
            source,
            body.key_names.clone(),
        )))
    }
}

/// `GET /api/v1/sync-targets`
pub async fn list(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    if let Some(project) = query.project_id.as_deref() {
        if let Err(resp) = access::require_project(
            &st,
            &who,
            &organization_id,
            project,
            ResourcePermission::Manage,
        )
        .await
        {
            return resp;
        }
    }
    if let Some(config) = query.config_id.as_deref() {
        if let Err(resp) = secret_config_access::config(
            &st,
            &who,
            &organization_id,
            config,
            ResourcePermission::Manage,
        )
        .await
        {
            return resp;
        }
    }
    match st
        .connection_broker
        .list_sync_targets(
            &organization_id,
            query.project_id.as_deref(),
            query.config_id.as_deref(),
        )
        .await
    {
        Ok(targets) => {
            let authorized =
                match access::retain_authorized(&st, &who, &organization_id, targets).await {
                    Ok(authorized) => authorized,
                    Err(resp) => return resp,
                };
            let body = json!({ "sync_targets": authorized });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(&e),
    }
}

/// `POST /api/v1/sync-targets/{id}/sync`
pub async fn sync_one(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<SyncBody>>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    let target = match st
        .connection_broker
        .get_sync_target(&organization_id, &id)
        .await
    {
        Ok(target) => target,
        Err(e) => return broker_error(&e),
    };
    let config = match secret_config_access::config(
        &st,
        &who,
        &organization_id,
        &target.config_id,
        ResourcePermission::Keys,
    )
    .await
    {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if config.project_id != target.project_id {
        return secret_config_access::hidden();
    }
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let secrets = match secret_source_from_body(&st, &who, &organization_id, &body) {
        Ok(secrets) => secrets,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .sync_target(&organization_id, &id, secrets)
        .await
    {
        Ok(outcome) => {
            let event_type = if outcome.ok {
                "sync.target.synced"
            } else {
                "sync.target.failed"
            };
            let _ = publish_sync_bus(
                &st,
                event_type,
                json!({
                    "target_id": outcome.target.id,
                    "project_id": outcome.target.project_id,
                    "config_id": outcome.target.config_id,
                    "content_version": outcome.content_version,
                    "ok": outcome.ok,
                    "keys_synced": outcome.keys_synced,
                }),
            )
            .await;
            let body = serde_json::to_value(&outcome).unwrap_or_else(|_| json!({}));
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(&e),
    }
}

/// `POST /api/v1/sync-targets/sync-all` — fan-out by `config_id`.
pub async fn sync_all(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncAllBody>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    let config_id = body.config_id.trim();
    if config_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"config_id is required"})),
        )
            .into_response();
    }
    // Authorize the config even when it has no targets. The caller-bound
    // source and per-target grants recheck every target at materialization.
    if let Err(resp) = secret_config_access::config(
        &st,
        &who,
        &organization_id,
        config_id,
        ResourcePermission::Keys,
    )
    .await
    {
        return resp;
    }
    let secrets = match secret_source_from_body(&st, &who, &organization_id, &SyncBody::default()) {
        Ok(secrets) => secrets,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .sync_all_for_config(&organization_id, config_id, secrets)
        .await
    {
        Ok(outcomes) => {
            for outcome in &outcomes {
                let event_type = if outcome.ok {
                    "sync.target.synced"
                } else {
                    "sync.target.failed"
                };
                let _ = publish_sync_bus(
                    &st,
                    event_type,
                    json!({
                        "target_id": outcome.target.id,
                        "project_id": outcome.target.project_id,
                        "config_id": outcome.target.config_id,
                        "content_version": outcome.content_version,
                        "ok": outcome.ok,
                        "keys_synced": outcome.keys_synced,
                    }),
                )
                .await;
            }
            let body = json!({ "outcomes": outcomes });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(&e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncAllBody {
    pub config_id: String,
}

#[cfg(test)]
#[path = "sync_targets_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "sync_targets_authorization_tests.rs"]
mod authorization_tests;
