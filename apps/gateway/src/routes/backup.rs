//! Backup target configuration (ADR 0039).
//!
//! An owner/admin points the organization at a GitHub repository once; from
//! then on the backup actor persists every secret change there with no human
//! in the loop. These routes carry configuration and status only — never
//! token material, never plaintext.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_storage::BackupTarget;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

fn require_configurator(st: &AppState, headers: &axum::http::HeaderMap) -> Result<(), Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error":"forbidden","hint":"owner or admin role required to configure backup"})),
        )
            .into_response());
    }
    Ok(())
}

fn target_view(target: &BackupTarget) -> serde_json::Value {
    json!({
        "integration_id": target.integration_id,
        "installation_id": target.installation_id,
        "owner": target.owner,
        "repo": target.repo,
        "branch": target.branch,
        "enabled": target.enabled,
        "status": target.status,
        "last_commit_sha": target.last_commit_sha,
        "last_synced_at": target.last_synced_at,
        "last_error": target.last_error,
    })
}

pub async fn get_target(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    let organization = st.connection_organization.to_string();
    let target = match st.db.get_backup_target(&organization).await {
        Ok(target) => target,
        Err(error) => return internal(error),
    };
    let pending = st.db.count_unpublished_outbox().await.unwrap_or(0);
    (
        StatusCode::OK,
        Json(json!({
            "target": target.as_ref().map(target_view),
            "pending_events": pending,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutTargetBody {
    pub integration_id: String,
    pub installation_id: String,
    pub owner: String,
    pub repo: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

fn valid_repo_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub async fn put_target(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PutTargetBody>,
) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    if !valid_repo_segment(&body.owner) || !valid_repo_segment(&body.repo) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"owner and repo must be GitHub name segments"})),
        )
            .into_response();
    }
    if body.installation_id.is_empty() || !body.installation_id.chars().all(|c| c.is_ascii_digit())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"installation_id must be the numeric id from the GitHub App installation"})),
        )
            .into_response();
    }
    let organization = st.connection_organization;
    // The target is only usable if the integration can mint installation
    // tokens; refusing here beats a silently suspended actor later.
    match st
        .connection_broker
        .github_app_signing_material(&organization, &body.integration_id)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({
                    "error": "integration_unusable",
                    "hint": "the integration holds no GitHub App signing material — register the app via POST /api/v1/providers/github/app first",
                })),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"integration_not_found","detail": error.to_string()})),
            )
                .into_response();
        }
    }
    let target = BackupTarget {
        organization_id: organization.to_string(),
        integration_id: body.integration_id,
        installation_id: body.installation_id,
        owner: body.owner,
        repo: body.repo,
        branch: body.branch.unwrap_or_else(|| "main".into()),
        enabled: body.enabled.unwrap_or(true),
        status: "pending".into(),
        last_commit_sha: None,
        last_synced_at: None,
        last_error: None,
    };
    if let Err(error) = st.db.upsert_backup_target(&target).await {
        return internal(error);
    }
    // A fresh target gets a full snapshot immediately: the resync event both
    // wakes the actor and reconciles anything dead-lettered while unconfigured.
    if let Err(error) = st
        .db
        .append_outbox("backup.resync", &json!({"reason":"target_updated"}).to_string())
        .await
    {
        return internal(error);
    }
    st.backup_notify.notify_one();
    (StatusCode::OK, Json(json!({"target": target_view(&target)}))).into_response()
}

pub async fn delete_target(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    let organization = st.connection_organization.to_string();
    if let Err(error) = st.db.delete_backup_target(&organization).await {
        return internal(error);
    }
    (StatusCode::OK, Json(json!({"deleted": true}))).into_response()
}

pub async fn resync(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_configurator(&st, &headers) {
        return resp;
    }
    if let Err(error) = st
        .db
        .append_outbox("backup.resync", &json!({"reason":"requested"}).to_string())
        .await
    {
        return internal(error);
    }
    st.backup_notify.notify_one();
    (StatusCode::ACCEPTED, Json(json!({"status":"queued"}))).into_response()
}

fn internal(error: anyhow::Error) -> Response {
    tracing::error!(%error, "backup route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use crate::app_state::{self, test_session_headers, AppState};
    use crate::config::{Args, DEV_OPERATOR_TOKEN};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use opensesame_connection_broker::github_app::GithubAppCredentials;
    use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn state() -> AppState {
        let mut state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let config = BrokerConfig::in_memory(Some([7u8; 32]), "http://127.0.0.1:8787");
        state.connection_broker =
            Arc::new(ConnectionBroker::new(state.db.pool().clone(), config).unwrap());
        state
    }

    async fn call(
        state: &AppState,
        method: &str,
        path: &str,
        headers: Option<axum::http::HeaderMap>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        match headers {
            Some(map) => {
                for (name, value) in map.iter() {
                    request = request.header(name, value);
                }
            }
            None => {
                request = request.header(
                    "authorization",
                    format!("Bearer operator:{DEV_OPERATOR_TOKEN}"),
                );
            }
        }
        let request = match body {
            Some(value) => request
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = super::super::router(state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn register_app(state: &AppState) -> String {
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)")
            .bind(state.connection_organization.to_string())
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(state.db.pool())
            .await
            .unwrap();
        state
            .connection_broker
            .register_github_app_credentials(
                &state.connection_organization,
                &GithubAppCredentials {
                    id: 99,
                    name: "App".into(),
                    client_id: "Iv1.x".into(),
                    client_secret: "s".into(),
                    html_url: None,
                    pem: Some("-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----".into()),
                    webhook_secret: None,
                },
                "test",
            )
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn a_member_cannot_configure_backup() {
        let state = state().await;
        let headers = test_session_headers(
            &state,
            "prn_member",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Member,
        );
        let (status, _) = call(&state, "GET", "/api/v1/backup/target", Some(headers), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn target_requires_signing_material_then_round_trips() {
        let state = state().await;
        // No registered app: refused with the fix named.
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": "missing",
                "installation_id": "1",
                "owner": "acme",
                "repo": "opensesame-passwords",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

        let integration = register_app(&state).await;
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "12345",
                "owner": "acme",
                "repo": "opensesame-passwords",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["repo"], "opensesame-passwords");

        // Configuring queued a resync event for the actor.
        assert!(state.db.count_unpublished_outbox().await.unwrap() >= 1);

        let (status, body) = call(&state, "GET", "/api/v1/backup/target", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["target"]["installation_id"], "12345");
        assert!(body["pending_events"].as_i64().unwrap() >= 1);

        let (status, _) = call(&state, "POST", "/api/v1/backup/resync", None, None).await;
        assert_eq!(status, StatusCode::ACCEPTED);

        let (status, _) = call(&state, "DELETE", "/api/v1/backup/target", None, None).await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = call(&state, "GET", "/api/v1/backup/target", None, None).await;
        assert!(body["target"].is_null());
    }

    #[tokio::test]
    async fn owner_and_repo_names_are_validated() {
        let state = state().await;
        let integration = register_app(&state).await;
        let (status, _) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "12345",
                "owner": "acme/../etc",
                "repo": "x",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
