//! Backup target configuration (ADR 0039).
//!
//! An owner/admin points the organization at a GitHub repository once; from
//! then on the backup actor persists every secret change there with no human
//! in the loop. These routes carry configuration and status only — never
//! token material, never plaintext.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_storage::BackupTarget;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_operator, resolve_caller, Caller};

fn require_configurator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<Caller, Response> {
    require_operator(st, headers)?;
    Ok(Caller::Operator)
}

fn target_view(target: &BackupTarget) -> serde_json::Value {
    json!({
        "kind": target.kind,
        "provider_id": target.provider_id,
        "connection_id": target.connection_id,
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

pub async fn get_target(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    let target = match st.db.get_backup_target(&organization).await {
        Ok(target) => target,
        Err(error) => return internal(&error),
    };
    // The Host outbox is gateway-wide. A tenant session must not learn the
    // unpublished depth of every other organization's backup work.
    let pending = match who {
        Caller::Operator => st.db.count_unpublished_outbox().await.unwrap_or(0),
        Caller::Session { .. } => 0,
    };
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
    /// `github_app` (default) or `connector` (ADR 0065 §6).
    #[serde(default)]
    pub kind: Option<String>,
    /// GitHub kind: a GitHub connection that can list/create repos.
    /// Connector kind: the Host connection that carries the uploads.
    #[serde(default)]
    pub connection_id: Option<String>,
    /// Required when `connection_id` is absent; otherwise derived from the connection.
    #[serde(default)]
    pub integration_id: Option<String>,
    #[serde(default)]
    pub installation_id: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Connector kind only: non-secret delivery shape (e.g. `base_url`).
    /// Secret-shaped keys are refused — credentials live sealed under the
    /// connection, never in target configuration.
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

/// The audit deny-pass, applied to configuration: any key that even looks
/// like it carries credential material is refused wholesale.
fn config_has_secret_shaped_key(value: &serde_json::Value) -> bool {
    const DENY: [&str; 9] = [
        "value",
        "secret",
        "password",
        "token",
        "authorization",
        "bearer",
        "cookie",
        "refresh",
        "key",
    ];
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
            let lower = k.to_ascii_lowercase();
            DENY.iter().any(|d| lower.contains(d)) || config_has_secret_shaped_key(v)
        }),
        serde_json::Value::Array(items) => items.iter().any(config_has_secret_shaped_key),
        _ => false,
    }
}

fn valid_repo_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.contains("..")
        && !value.contains('\\')
        && value
            .chars()
            .all(|c| c.is_ascii() && !c.is_control() && c != ' ' && c != '?')
}

fn validated_branch(body: &PutTargetBody) -> Result<(String, String, String, String), Response> {
    let owner = body.owner.clone().unwrap_or_default();
    let repo = body.repo.clone().unwrap_or_default();
    let installation_id = body.installation_id.clone().unwrap_or_default();
    if !valid_repo_segment(&owner) || !valid_repo_segment(&repo) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"owner and repo must be GitHub name segments"})),
        )
            .into_response());
    }
    if installation_id.is_empty() || !installation_id.chars().all(|char| char.is_ascii_digit()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"installation_id must be the numeric id from the GitHub App installation"})),
        )
            .into_response());
    }
    let branch = body
        .branch
        .clone()
        .unwrap_or_else(|| "env/production".into());
    if !valid_branch(&branch) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"branch must be a Git ref name"})),
        )
            .into_response());
    }
    Ok((branch, owner, repo, installation_id))
}

async fn resolve_integration_id(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    body: &PutTargetBody,
) -> Result<String, Response> {
    if let Some(connection_id) = body
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return match st
            .connection_broker
            .get_connection(organization, connection_id)
            .await
        {
            Ok(view) if view.provider_id == "github" => view.integration_id.ok_or_else(|| {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({
                        "error": "integration_required",
                        "hint": "that GitHub connection is not bound to a tenant App integration — Create GitHub App under History first",
                    })),
                )
                    .into_response()
            }),
            Ok(_) => Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_request","hint":"connection must be a GitHub connection"})),
            )
                .into_response()),
            Err(_) => Err((
                StatusCode::NOT_FOUND,
                Json(json!({"error":"connection_not_found"})),
            )
                .into_response()),
        };
    }
    body.integration_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_request","hint":"connection_id or integration_id is required"})),
            )
                .into_response()
        })
}

/// Configure a connector-kind target (ADR 0065 §6): snapshots deliver
/// through the named Host connection's authorized egress. Configuration is
/// refused unless the connection exists and the config is secret-free with
/// an https `base_url` — the same checks the actor re-runs at delivery time.
async fn put_connector_target(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    body: PutTargetBody,
) -> Response {
    let Some(connection_id) = body
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"error":"invalid_request","hint":"connector targets require connection_id"}),
            ),
        )
            .into_response();
    };
    let Ok(view) = st
        .connection_broker
        .get_connection(organization, connection_id)
        .await
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"connection_not_found"})),
        )
            .into_response();
    };
    let Some(config) = body.config else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"connector targets require config.base_url"})),
        )
            .into_response();
    };
    if config_has_secret_shaped_key(&config) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_request",
                "hint": "config keys must be digest-shaped: no value/secret/token/key-shaped names — credentials live sealed under the connection",
            })),
        )
            .into_response();
    }
    let base_url_ok = config
        .get("base_url")
        .and_then(|v| v.as_str())
        .is_some_and(|u| u.starts_with("https://") && !u["https://".len()..].is_empty());
    if !base_url_ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"config.base_url must be an https URL inside the connection's egress"})),
        )
            .into_response();
    }
    let target = BackupTarget {
        organization_id: organization.to_string(),
        integration_id: String::new(),
        installation_id: String::new(),
        owner: String::new(),
        repo: String::new(),
        branch: String::new(),
        enabled: body.enabled.unwrap_or(true),
        status: "pending".into(),
        last_commit_sha: None,
        last_synced_at: None,
        last_error: None,
        kind: crate::backup_target::KIND_CONNECTOR.into(),
        provider_id: Some(view.provider_id.clone()),
        connection_id: Some(connection_id.to_owned()),
        config: Some(config.to_string()),
    };
    if let Err(error) = st.db.upsert_backup_target(&target).await {
        return internal(&error);
    }
    let outbox_id = match st
        .db
        .append_outbox(
            "backup.resync",
            &json!({"reason":"target_updated"}).to_string(),
        )
        .await
    {
        Ok(id) => id,
        Err(error) => return internal(&error),
    };
    crate::backup_bus::publish_backup_wake(st, &outbox_id).await;
    (
        StatusCode::OK,
        Json(json!({"target": target_view(&target)})),
    )
        .into_response()
}

pub async fn put_target(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PutTargetBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization);
    let kind = body.kind.as_deref().unwrap_or("github_app");
    if kind == crate::backup_target::KIND_CONNECTOR {
        return put_connector_target(&st, &organization, body).await;
    }
    if kind != crate::backup_target::KIND_GITHUB_APP {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"kind must be github_app or connector"})),
        )
            .into_response();
    }
    let (branch, owner, repo, installation_id) = match validated_branch(&body) {
        Ok(parts) => parts,
        Err(response) => return response,
    };
    let integration_id = match resolve_integration_id(&st, &organization, &body).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    // The target is only usable if the integration can mint installation
    // tokens; refusing here beats a silently suspended actor later.
    match st
        .connection_broker
        .github_app_signing_material(&organization, &integration_id)
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
        Err(_error) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"integration_not_found"})),
            )
                .into_response();
        }
    }
    let target = BackupTarget {
        organization_id: organization.to_string(),
        integration_id,
        installation_id,
        owner,
        repo,
        // ADR 0043: recoverability defaults to the production env branch.
        branch,
        enabled: body.enabled.unwrap_or(true),
        status: "pending".into(),
        last_commit_sha: None,
        last_synced_at: None,
        last_error: None,
        kind: crate::backup_target::KIND_GITHUB_APP.into(),
        provider_id: None,
        connection_id: None,
        config: None,
    };
    if let Err(error) = st.db.upsert_backup_target(&target).await {
        return internal(&error);
    }
    // A fresh target gets a full snapshot immediately: the resync event both
    // wakes the actor and reconciles anything dead-lettered while unconfigured.
    let outbox_id = match st
        .db
        .append_outbox(
            "backup.resync",
            &json!({"reason":"target_updated"}).to_string(),
        )
        .await
    {
        Ok(id) => id,
        Err(error) => return internal(&error),
    };
    crate::backup_bus::publish_backup_wake(&st, &outbox_id).await;
    (
        StatusCode::OK,
        Json(json!({"target": target_view(&target)})),
    )
        .into_response()
}

/// `GET /api/v1/integrations/{id}/github/installations` — App installs only (no tokens).
pub async fn list_installations(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if !who.can_configure_integrations() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let organization = who.organization(st.connection_organization);
    match st
        .connection_broker
        .list_github_app_installations(&organization, &id)
        .await
    {
        Ok(rows) => (
            StatusCode::OK,
            Json(json!({
                "installations": rows.iter().map(|row| json!({
                    "id": row.id,
                    "account_login": row.account_login,
                    "account_type": row.account_type,
                    "target_type": row.target_type,
                })).collect::<Vec<_>>(),
            })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": error.code(),
                "hint": "backup source is unavailable",
            })),
        )
            .into_response(),
    }
}

pub async fn delete_target(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    if let Err(error) = st.db.delete_backup_target(&organization).await {
        return internal(&error);
    }
    (StatusCode::OK, Json(json!({"deleted": true}))).into_response()
}

pub async fn resync(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    if !resync_allowed() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"rate_limited","hint":"wait before requesting another resync"})),
        )
            .into_response();
    }
    let outbox_id = match st
        .db
        .append_outbox(
            "backup.resync",
            &json!({"reason":"requested","organization_id": organization}).to_string(),
        )
        .await
    {
        Ok(id) => id,
        Err(error) => return internal(&error),
    };
    crate::backup_bus::publish_backup_wake(&st, &outbox_id).await;
    (StatusCode::ACCEPTED, Json(json!({"status":"queued"}))).into_response()
}

fn resync_allowed() -> bool {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static WINDOW: OnceLock<Mutex<Vec<Instant>>> = OnceLock::new();
    let mut stamps = WINDOW
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cutoff = Instant::now().checked_sub(Duration::from_secs(60)).unwrap();
    stamps.retain(|at| *at > cutoff);
    if stamps.len() >= 6 {
        return false;
    }
    stamps.push(Instant::now());
    true
}

fn internal(error: &anyhow::Error) -> Response {
    tracing::error!(%error, "backup route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal"})),
    )
        .into_response()
}

#[cfg(test)]
#[expect(
    clippy::items_after_statements,
    reason = "the backup route tests define scenario-local fault fixtures beside their use"
)]
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
                for (name, value) in &map {
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
        let response = super::super::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn register_app(state: &AppState) -> String {
        sqlx::query(
            "INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)",
        )
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
                    pem: Some(
                        "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----"
                            .into(),
                    ),
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
        assert_eq!(status, StatusCode::UNAUTHORIZED);
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

    #[tokio::test]
    async fn put_target_defaults_to_env_production_branch() {
        let state = state().await;
        let integration = register_app(&state).await;
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "99",
                "owner": "acme",
                "repo": "opensesame-passwords",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["branch"], "env/production");
    }

    #[tokio::test]
    async fn put_target_accepts_connection_id_for_github_only() {
        let state = state().await;
        let integration = register_app(&state).await;
        let connection = state
            .connection_broker
            .create_connection(
                &state.connection_organization,
                opensesame_connection_broker::CreateConnection {
                    provider_id: "github".into(),
                    integration_id: Some(integration.clone()),
                    owner_subject: Some("user:demo".into()),
                    display_name: Some("History".into()),
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: None,
                },
            )
            .await
            .unwrap();

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "connection_id": connection.connection_id,
                "installation_id": "4242",
                "owner": "acme",
                "repo": "opensesame-passwords",
                "branch": "env/staging",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["integration_id"], integration);
        assert_eq!(body["target"]["branch"], "env/staging");

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "connection_id": "connection:missing",
                "installation_id": "1",
                "owner": "acme",
                "repo": "r",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    #[tokio::test]
    async fn installations_route_refuses_integrations_without_app_material() {
        let state = state().await;
        let (status, body) = call(
            &state,
            "GET",
            "/api/v1/integrations/missing/github/installations",
            None,
            None,
        )
        .await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::UNPROCESSABLE_ENTITY,
            "{status} {body}"
        );
    }

    #[tokio::test]
    async fn list_installations_is_scoped_to_caller_organization() {
        let state = state().await;
        let integration = register_app(&state).await;
        let foreign = opensesame_domain::OrganizationId::new();
        let headers = test_session_headers(
            &state,
            "prn_foreign",
            foreign,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, body) = call(
            &state,
            "GET",
            &format!("/api/v1/integrations/{integration}/github/installations"),
            Some(headers),
            None,
        )
        .await;
        if status == StatusCode::OK {
            let rows = body["installations"].as_array().expect("installations");
            assert!(
                rows.is_empty(),
                "foreign org must not see another org's GitHub App installs: {body}"
            );
        } else {
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        }
    }

    #[tokio::test]
    async fn resync_publishes_backup_wake_on_taskbus() {
        let _guard = crate::app_state::test_env::lock();
        use opensesame_task_bus::{InMemoryTaskBus, TaskBus};
        use std::sync::Arc;
        use tokio::sync::RwLock;

        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        let mut state = state().await;
        let mem = Arc::new(InMemoryTaskBus::default());
        let as_dyn: Arc<dyn opensesame_task_bus::TaskBus> = mem.clone();
        state.task_bus = Arc::new(RwLock::new(as_dyn));

        let (status, body) = call(&state, "POST", "/api/v1/backup/resync", None, None).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);

        let events = mem.drain(10).await.unwrap();
        assert!(
            events.iter().any(|e| e.r#type == "system.backup.wake"),
            "expected backup wake on bus, got {events:?}"
        );
        assert!(events
            .iter()
            .all(|e| !e.data.to_string().contains("BEGIN RSA")));
    }

    #[tokio::test]
    async fn tenant_session_cannot_access_host_global_backup() {
        let state = state().await;
        state
            .db
            .append_outbox("backup.resync", r#"{"reason":"requested"}"#)
            .await
            .unwrap();
        let headers = test_session_headers(
            &state,
            "prn_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, body) =
            call(&state, "GET", "/api/v1/backup/target", Some(headers), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert!(state.db.count_unpublished_outbox().await.unwrap() >= 1);
    }
}
