//! Project-config secret routes (ADR 0052).
//!
//! The value intake (`PUT …/secrets`) is write-only: every response on this
//! surface carries key names and version metadata, never values, and passes
//! `assert_no_secret_fields`. Reads (config metadata, key lists, versions,
//! compare) accept any authenticated caller in the organization; mutations
//! require the owner/admin integration role. Operator materialize is
//! deliberately NOT on this surface yet — it lands with the frozen
//! `secret.value.materialized` vocabulary event.

use std::collections::BTreeMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::CreateSecretConfig;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};
use crate::routes::connections::broker_error;

#[allow(clippy::result_large_err)]
fn authorize_read(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    resolve_caller(st, headers)
}

#[allow(clippy::result_large_err)]
fn authorize_write(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to manage secret configs"
            })),
        )
            .into_response());
    }
    Ok(who)
}

const OPERATOR_ORGANIZATION_HEADER: &str = "x-opensesame-organization";

#[allow(clippy::result_large_err)]
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

fn actor_of(who: &Caller) -> Option<String> {
    match who {
        Caller::Operator => Some("operator".into()),
        Caller::Session { subject, .. } => Some(subject.clone()),
    }
}

/// Same recursive credential-shape guard as the sync-target surface.
#[allow(clippy::result_large_err)]
fn assert_no_secret_fields(value: &serde_json::Value) -> Result<(), Response> {
    let text = value.to_string().to_ascii_lowercase();
    for leak in [
        "\"access_token\"",
        "\"refresh_token\"",
        "\"client_secret\"",
        "\"code_verifier\"",
        "\"password\"",
        "\"value\"",
        "\"plaintext\"",
    ] {
        if text.contains(leak) {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "internal_error",
                    "hint": "config response refused: credential-shaped field"
                })),
            )
                .into_response());
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateConfigBody {
    pub slug: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub environment: String,
    #[serde(default)]
    pub parent_config_id: Option<String>,
}

/// The one value-accepting request shape on this plane. Values are sealed on
/// arrival; the response echoes names + versions only.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutSecretsBody {
    pub secrets: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollbackBody {
    pub to_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BranchBody {
    pub slug: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// `GET /api/v1/projects/{project_id}/configs`
pub async fn list_for_project(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<String>,
) -> Response {
    let who = match authorize_read(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .list_secret_configs(&organization_id.to_string(), &project_id)
        .await
    {
        Ok(configs) => {
            let body = json!({ "configs": configs });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `POST /api/v1/projects/{project_id}/configs`
pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<String>,
    Json(body): Json<CreateConfigBody>,
) -> Response {
    let who = match authorize_write(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .create_secret_config(
            &organization_id.to_string(),
            CreateSecretConfig {
                project_id,
                slug: body.slug,
                display_name: body.display_name,
                environment: body.environment,
                parent_config_id: body.parent_config_id,
            },
            actor_of(&who).as_deref(),
        )
        .await
    {
        Ok(view) => {
            let body = serde_json::to_value(&view).unwrap_or_else(|_| json!({}));
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::CREATED, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `GET /api/v1/configs/{id}`
pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize_read(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .get_secret_config_view(&organization_id.to_string(), &id)
        .await
    {
        Ok(view) => {
            let body = serde_json::to_value(&view).unwrap_or_else(|_| json!({}));
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `DELETE /api/v1/configs/{id}` — refuses while sync targets reference it.
pub async fn delete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize_write(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .delete_secret_config(&organization_id.to_string(), &id, actor_of(&who).as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(e),
    }
}

/// `PUT /api/v1/configs/{id}/secrets` — write-only value intake.
pub async fn put_secrets(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PutSecretsBody>,
) -> Response {
    let who = match authorize_write(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .put_config_secrets(
            &organization_id.to_string(),
            &id,
            &body.secrets,
            actor_of(&who).as_deref(),
        )
        .await
    {
        Ok(keys) => {
            let body = json!({ "keys": keys });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `GET /api/v1/configs/{id}/secrets` — key names + versions, never values.
pub async fn list_keys(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize_read(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .config_key_meta(&organization_id.to_string(), &id)
        .await
    {
        Ok(keys) => {
            let body = json!({ "keys": keys });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `DELETE /api/v1/configs/{id}/secrets/{key}`
pub async fn delete_secret(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Response {
    let who = match authorize_write(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .delete_config_secret(
            &organization_id.to_string(),
            &id,
            &key,
            actor_of(&who).as_deref(),
        )
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(e),
    }
}

/// `GET /api/v1/configs/{id}/secrets/{key}/versions` — metadata only.
pub async fn list_versions(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Response {
    let who = match authorize_read(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .config_value_versions(&organization_id.to_string(), &id, &key)
        .await
    {
        Ok(versions) => {
            let body = json!({
                "versions": versions
                    .into_iter()
                    .map(|v| json!({
                        "version": v.version,
                        "deleted": v.deleted,
                        "actor_id": v.actor_id,
                        "created_at": v.created_at.to_rfc3339(),
                    }))
                    .collect::<Vec<_>>()
            });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `POST /api/v1/configs/{id}/secrets/{key}/rollback` — re-seals the old
/// version as a new head version; never copies ciphertext between slots.
pub async fn rollback(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, key)): Path<(String, String)>,
    Json(body): Json<RollbackBody>,
) -> Response {
    let who = match authorize_write(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    match st
        .connection_broker
        .rollback_config_secret(
            &organization_id.to_string(),
            &id,
            &key,
            body.to_version,
            actor_of(&who).as_deref(),
        )
        .await
    {
        Ok(new_version) => {
            let body = json!({ "key_name": key, "version": new_version });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
}

/// `GET /api/v1/configs/{a}/compare/{b}` — presence + versions only. Equality
/// of values is deliberately NOT reported: the sealing AAD binds the config
/// id, so ciphertext comparison across configs proves nothing, and decrypting
/// to compare would turn this endpoint into an equality oracle.
pub async fn compare(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((a, b)): Path<(String, String)>,
) -> Response {
    let who = match authorize_read(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    let org = organization_id.to_string();
    let left = match st.connection_broker.config_key_meta(&org, &a).await {
        Ok(keys) => keys,
        Err(e) => return broker_error(e),
    };
    let right = match st.connection_broker.config_key_meta(&org, &b).await {
        Ok(keys) => keys,
        Err(e) => return broker_error(e),
    };
    let right_map: BTreeMap<&str, u64> = right
        .iter()
        .map(|k| (k.key_name.as_str(), k.version))
        .collect();
    let mut only_in_a = Vec::new();
    let mut in_both = Vec::new();
    for key in &left {
        match right_map.get(key.key_name.as_str()) {
            Some(b_version) => in_both.push(json!({
                "key_name": key.key_name,
                "a_version": key.version,
                "b_version": b_version,
            })),
            None => only_in_a.push(key.key_name.clone()),
        }
    }
    let left_names: std::collections::BTreeSet<&str> =
        left.iter().map(|k| k.key_name.as_str()).collect();
    let only_in_b: Vec<String> = right
        .iter()
        .filter(|k| !left_names.contains(k.key_name.as_str()))
        .map(|k| k.key_name.clone())
        .collect();
    let body = json!({
        "only_in_a": only_in_a,
        "only_in_b": only_in_b,
        "in_both": in_both,
    });
    if let Err(resp) = assert_no_secret_fields(&body) {
        return resp;
    }
    (StatusCode::OK, Json(body)).into_response()
}

/// `POST /api/v1/configs/{id}/branch` — child config inheriting this one.
pub async fn branch(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<BranchBody>,
) -> Response {
    let who = match authorize_write(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    let org = organization_id.to_string();
    let parent = match st.connection_broker.get_secret_config_view(&org, &id).await {
        Ok(view) => view,
        Err(e) => return broker_error(e),
    };
    match st
        .connection_broker
        .create_secret_config(
            &org,
            CreateSecretConfig {
                project_id: parent.project_id,
                slug: body.slug,
                display_name: body.display_name,
                environment: parent.environment,
                parent_config_id: Some(parent.id),
            },
            actor_of(&who).as_deref(),
        )
        .await
    {
        Ok(view) => {
            let body = serde_json::to_value(&view).unwrap_or_else(|_| json!({}));
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::CREATED, Json(body)).into_response()
        }
        Err(e) => broker_error(e),
    }
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
    use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
    use opensesame_domain::OrganizationRole;
    use std::sync::Arc;
    use tower::ServiceExt;

    const PLAINTEXT: &str = "sw0rdf1sh-route-secret";

    fn router(state: AppState) -> Router {
        crate::routes::router(state)
    }

    async fn state_with_seal_key() -> AppState {
        let mut st = test_demo_state().await;
        st.connection_broker = Arc::new(
            ConnectionBroker::new(
                st.db.pool().clone(),
                BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
            )
            .unwrap(),
        );
        st
    }

    async fn send(
        app: &Router,
        headers: &axum::http::HeaderMap,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder().method(method).uri(uri).header(
            "authorization",
            headers.get("authorization").unwrap().as_bytes(),
        );
        let body = match body {
            Some(json) => {
                builder = builder.header("content-type", "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let res = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
        };
        (status, value)
    }

    #[tokio::test]
    async fn config_lifecycle_never_returns_a_value() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:cfg-admin", org, OrganizationRole::Admin);
        let app = router(st.clone());

        let (status, created) = send(
            &app,
            &admin,
            "POST",
            "/api/v1/projects/proj-1/configs",
            Some(json!({"slug": "development", "environment": "development"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let config_id = created["id"].as_str().unwrap().to_string();

        let (status, put) = send(
            &app,
            &admin,
            "PUT",
            &format!("/api/v1/configs/{config_id}/secrets"),
            Some(json!({"secrets": {"API_KEY": PLAINTEXT, "DB_URL": "postgres://u@h/db"}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!put.to_string().contains(PLAINTEXT));
        assert_eq!(put["keys"].as_array().unwrap().len(), 2);

        let (status, keys) = send(
            &app,
            &admin,
            "GET",
            &format!("/api/v1/configs/{config_id}/secrets"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!keys.to_string().contains(PLAINTEXT));

        // Second write, then versions + rollback; every response stays blind.
        let (_, _) = send(
            &app,
            &admin,
            "PUT",
            &format!("/api/v1/configs/{config_id}/secrets"),
            Some(json!({"secrets": {"API_KEY": "replacement"}})),
        )
        .await;
        let (status, versions) = send(
            &app,
            &admin,
            "GET",
            &format!("/api/v1/configs/{config_id}/secrets/API_KEY/versions"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(versions["versions"].as_array().unwrap().len(), 2);
        assert!(!versions.to_string().contains(PLAINTEXT));

        let (status, rolled) = send(
            &app,
            &admin,
            "POST",
            &format!("/api/v1/configs/{config_id}/secrets/API_KEY/rollback"),
            Some(json!({"to_version": 1})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(rolled["version"].as_u64().unwrap(), 3);
        assert!(!rolled.to_string().contains(PLAINTEXT));

        // Branch inherits environment and parent linkage.
        let (status, child) = send(
            &app,
            &admin,
            "POST",
            &format!("/api/v1/configs/{config_id}/branch"),
            Some(json!({"slug": "dev-tyler"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(child["parent_config_id"].as_str().unwrap(), config_id);

        // Compare is presence + versions only.
        let child_id = child["id"].as_str().unwrap();
        let (status, diff) = send(
            &app,
            &admin,
            "GET",
            &format!("/api/v1/configs/{config_id}/compare/{child_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(diff["only_in_a"].as_array().unwrap().len(), 2);
        assert!(!diff.to_string().contains(PLAINTEXT));

        let (status, _) = send(
            &app,
            &admin,
            "DELETE",
            &format!("/api/v1/configs/{config_id}/secrets/DB_URL"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn member_sessions_read_metadata_but_cannot_mutate() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:cfg-admin", org, OrganizationRole::Admin);
        let member =
            test_session_headers(&st, "principal:cfg-member", org, OrganizationRole::Member);
        let app = router(st.clone());

        let (_, created) = send(
            &app,
            &admin,
            "POST",
            "/api/v1/projects/proj-1/configs",
            Some(json!({"slug": "staging", "environment": "staging"})),
        )
        .await;
        let config_id = created["id"].as_str().unwrap();

        let (status, _) = send(
            &app,
            &member,
            "GET",
            &format!("/api/v1/configs/{config_id}/secrets"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = send(
            &app,
            &member,
            "PUT",
            &format!("/api/v1/configs/{config_id}/secrets"),
            Some(json!({"secrets": {"K": "v"}})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send(
            &app,
            &member,
            "POST",
            "/api/v1/projects/proj-1/configs",
            Some(json!({"slug": "nope", "environment": "custom"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn sync_with_stored_values_fails_closed_without_leaking() {
        use opensesame_connection_broker::{CreateConnection, CreateSyncTarget};
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let admin = test_session_headers(&st, "principal:cfg-admin", org, OrganizationRole::Admin);
        let app = router(st.clone());

        let (_, created) = send(
            &app,
            &admin,
            "POST",
            "/api/v1/projects/proj-sync/configs",
            Some(json!({"slug": "production", "environment": "production"})),
        )
        .await;
        let config_id = created["id"].as_str().unwrap().to_string();
        let (_, _) = send(
            &app,
            &admin,
            "PUT",
            &format!("/api/v1/configs/{config_id}/secrets"),
            Some(json!({"secrets": {"API_KEY": PLAINTEXT}})),
        )
        .await;

        let connection = st
            .connection_broker
            .create_connection(
                &org,
                CreateConnection {
                    provider_id: "vercel".into(),
                    integration_id: None,
                    owner_subject: Some("principal:cfg-admin".into()),
                    display_name: Some("Vercel".into()),
                    logical_name: None,
                    project_id: Some("proj-sync".into()),
                    scopes: None,
                    shareability: None,
                },
            )
            .await
            .unwrap();
        st.connection_broker
            .set_api_key(&org, &connection.connection_id, "vercel_live_token")
            .await
            .unwrap();
        let target = st
            .connection_broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "proj-sync".into(),
                    config_id: config_id.clone(),
                    connection_id: connection.connection_id.clone(),
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();

        // Egress to api.vercel.com cannot succeed here; what matters is that
        // the failure surface — status detail, response body, bus events —
        // never carries the stored value or the connection token.
        let (status, outcome) = send(
            &app,
            &admin,
            "POST",
            &format!("/api/v1/sync-targets/{}/sync", target.id),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let text = outcome.to_string();
        assert!(!text.contains(PLAINTEXT));
        assert!(!text.contains("vercel_live_token"));

        let events = st.task_bus.read().await.drain(20).await.unwrap();
        for event in &events {
            let data = event.data.to_string();
            assert!(!data.contains(PLAINTEXT));
            assert!(!data.contains("vercel_live_token"));
        }
    }
}
