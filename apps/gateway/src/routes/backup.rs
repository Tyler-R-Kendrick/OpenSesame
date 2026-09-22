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

/// Queue a full-snapshot resync for `organization`. Payload always carries
/// `organization_id` so the backup actor can group the event (ADR 0039).
async fn queue_backup_resync(
    st: &AppState,
    organization: &str,
    reason: &str,
) -> Result<String, Response> {
    let outbox_id = st
        .db
        .append_outbox(
            "backup.resync",
            &json!({
                "reason": reason,
                "organization_id": organization,
            })
            .to_string(),
        )
        .await
        .map_err(|error| internal(&error))?;
    crate::backup_bus::publish_backup_wake(st, &outbox_id).await;
    Ok(outbox_id)
}

fn target_view(target: &BackupTarget) -> serde_json::Value {
    let config = target
        .config
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
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
        "config": config,
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
    // Enabling (or first bind) must publish an initial sync; disabling must not
    // enqueue work the actor will only dead-letter.
    if target.enabled {
        if let Err(response) =
            queue_backup_resync(st, &organization.to_string(), "target_updated").await
        {
            return response;
        }
    }
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
    // Initial bind and re-enable publish a full sync; disable does not enqueue.
    if target.enabled {
        if let Err(response) =
            queue_backup_resync(&st, &organization.to_string(), "target_updated").await
        {
            return response;
        }
    }
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
                    "id": row.id, "account_login": row.account_login,
                    "account_type": row.account_type, "target_type": row.target_type,
                    "repository_selection": row.repository_selection,
                    "permissions": row.permissions, "repositories": row.repositories,
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
    if let Err(response) = queue_backup_resync(&st, &organization, "requested").await {
        return response;
    }
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
#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "backup_tests_more.rs"]
mod tests_more;
