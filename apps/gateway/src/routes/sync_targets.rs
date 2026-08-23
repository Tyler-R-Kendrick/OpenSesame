//! Sync target routes (WP-C / ADR 0041).
//!
//! Create / list / delete / sync fan-out. Responses never include secret values.
//! Bus events (`sync.target.*`) publish via the injected [`TaskBus`].

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{CreateSyncTarget, KeyFilteredSecretSource, SyncSecretSource};
use opensesame_task_bus::BusEvent;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};
use crate::routes::connections::broker_error;

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
    Ok(who)
}

const OPERATOR_ORGANIZATION_HEADER: &str = "x-opensesame-organization";

fn caller_organization(
    st: &AppState,
    who: &Caller,
    headers: &axum::http::HeaderMap,
) -> Result<opensesame_domain::OrganizationId, Response> {
    let selected = headers.get(OPERATOR_ORGANIZATION_HEADER);
    match who {
        Caller::Operator => match selected {
            Some(raw) => match raw.to_str().ok().and_then(|value| {
                opensesame_domain::OrganizationId::parse(value)
                    .ok()
                    .filter(|id| id.to_string() == value)
            }) {
                Some(id) => Ok(id),
                _ => Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "invalid_request",
                        "hint": "x-opensesame-organization must be a canonical organization id"
                    })),
                )
                    .into_response()),
            },
            None => Ok(who.organization(st.connection_organization)),
        },
        Caller::Session { .. } => {
            if selected.is_some() {
                Err((
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "error": "forbidden",
                        "hint": "sessions cannot select an organization header"
                    })),
                )
                    .into_response())
            } else {
                Ok(who.organization(st.connection_organization))
            }
        }
    }
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
/// project-config store (`broker.sync_secret_source()`); clients can never
/// supply values on this API.
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

/// Production secret source: the host-sealed config store, optionally
/// narrowed to the key names the caller listed. Fails when the deployment
/// seal key is unset — a keyless deployment cannot sync.
#[allow(clippy::result_large_err)]
fn secret_source_from_body(
    st: &AppState,
    body: &SyncBody,
) -> Result<Arc<dyn SyncSecretSource>, Response> {
    let source = st
        .connection_broker
        .sync_secret_source()
        .map_err(broker_error)?;
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
            let body = json!({ "sync_targets": targets });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `POST /api/v1/sync-targets`
pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateBody>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .create_sync_target(
            &organization_id,
            CreateSyncTarget {
                project_id: body.project_id,
                config_id: body.config_id,
                connection_id: body.connection_id,
                operation: body.operation,
            },
        )
        .await
    {
        Ok(target) => {
            let body = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            let _ = publish_sync_bus(
                &st,
                "sync.target.created",
                json!({
                    "target_id": target.id,
                    "project_id": target.project_id,
                    "config_id": target.config_id,
                    "provider_id": target.provider_id,
                }),
            )
            .await;
            (StatusCode::CREATED, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `GET /api/v1/sync-targets/{id}`
pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .get_sync_target(&organization_id, &id)
        .await
    {
        Ok(target) => {
            let body = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `DELETE /api/v1/sync-targets/{id}`
pub async fn delete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .delete_sync_target(&organization_id, &id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(e),
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
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let secrets = match secret_source_from_body(&st, &body) {
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
        Err(e) => broker_error(e),
    }
}

/// `POST /api/v1/sync-targets/sync-all` — fan-out by config_id.
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
    let secrets = match secret_source_from_body(&st, &SyncBody::default()) {
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
        Err(e) => broker_error(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncAllBody {
    pub config_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{test_demo_state, test_session_headers};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use opensesame_connection_broker::{
        BrokerConfig, BrokerError, ConnectionBroker, CreateConnection, MapSecretSource,
    };
    use opensesame_domain::{OrganizationRole, Shareability};
    use tower::ServiceExt;

    fn router(state: AppState) -> Router {
        crate::routes::router(state)
    }

    async fn auth_headers(st: &AppState) -> axum::http::HeaderMap {
        let org = st.connection_organization;
        test_session_headers(st, "principal:sync-tester", org, OrganizationRole::Admin)
    }

    #[tokio::test]
    async fn sync_target_crud_and_bus_without_secret_leak() {
        let mut st = test_demo_state().await;
        st.connection_broker = Arc::new(
            ConnectionBroker::new(
                st.db.pool().clone(),
                BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
            )
            .unwrap(),
        );
        let org = st.connection_organization;
        let connection = st
            .connection_broker
            .create_connection(
                &org,
                CreateConnection {
                    provider_id: "vercel".into(),
                    integration_id: None,
                    owner_subject: Some("principal:sync-tester".into()),
                    display_name: Some("Vercel".into()),
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: Some(Shareability::Private),
                },
            )
            .await
            .unwrap();
        st.connection_broker
            .set_api_key(&org, &connection.connection_id, "vercel_live_token")
            .await
            .unwrap();

        // The production secret source resolves the config from the ADR 0052
        // store, so the target must reference a real config. Keys stay empty:
        // egress short-circuits and the sync records ready with zero keys.
        let config = st
            .connection_broker
            .create_secret_config(
                &org.to_string(),
                opensesame_connection_broker::CreateSecretConfig {
                    project_id: "project:1".into(),
                    slug: "production".into(),
                    display_name: None,
                    environment: "production".into(),
                    parent_config_id: None,
                },
                None,
            )
            .await
            .unwrap();

        let headers = auth_headers(&st).await;
        let app = router(st.clone());

        let create_req = Request::builder()
            .method("POST")
            .uri("/api/v1/sync-targets")
            .header("content-type", "application/json")
            .header(
                "authorization",
                headers.get("authorization").unwrap().as_bytes(),
            )
            .body(Body::from(
                json!({
                    "project_id": "project:1",
                    "config_id": config.id,
                    "connection_id": connection.connection_id,
                    "operation": "env.set"
                })
                .to_string(),
            ))
            .unwrap();
        let res = app.clone().oneshot(create_req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let text = created.to_string();
        assert!(!text.contains("vercel_live_token"));
        assert!(created.get("access_token").is_none());
        let id = created["id"].as_str().unwrap().to_string();

        let sync_req = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/sync-targets/{id}/sync"))
            .header("content-type", "application/json")
            .header(
                "authorization",
                headers.get("authorization").unwrap().as_bytes(),
            )
            .body(Body::from("{}"))
            .unwrap();
        let res = app.clone().oneshot(sync_req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let outcome: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(!outcome.to_string().contains("vercel_live_token"));
        assert!(outcome["ok"].as_bool().unwrap());

        let events = st.task_bus.read().await.drain(20).await.unwrap();
        assert!(events.iter().any(|e| e.r#type == "sync.target.created"));
        assert!(events.iter().any(|e| e.r#type == "sync.target.synced"));
        for event in &events {
            assert!(!event.data.to_string().contains("vercel_live_token"));
        }

        // MapSecretSource path is Host-only — ensure trait object compiles in tests.
        let _host_only: Arc<dyn SyncSecretSource> = Arc::new(MapSecretSource {
            entries: Default::default(),
        });
        let _ = BrokerError::SyncTargetNotFound;
    }
}
