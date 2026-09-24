//! Project-config secret routes (ADR 0052).
//!
//! The value intake (`PUT …/secrets`) is write-only: every response on this
//! surface carries key names and version metadata, never values, and passes
//! `assert_no_secret_fields`. Reads (config metadata, key lists, versions,
//! compare) require explicit project metadata/key capabilities; mutations
//! require a current durable owner/admin ceiling. Operator materialize is
//! deliberately NOT on this surface yet — it lands with the frozen
//! `secret.value.materialized` vocabulary event.

#[cfg(test)]
use crate::test_principals::{P04, P05};
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
use crate::middleware::auth::{
    resolve_caller as authorize_read, resolve_caller as authorize_write, Caller,
};
use crate::routes::connections::broker_error;

#[path = "secret_config_access.rs"]
pub(super) mod access;
use access::organization as caller_organization;
use opensesame_connection_broker::config_access::ResourcePermission;

macro_rules! organization_or_return {
    ($st:expr, $who:expr, $headers:expr) => {
        match caller_organization($st, $who, $headers) {
            Ok(organization_id) => organization_id,
            Err(response) => return response,
        }
    };
}

fn actor_of(who: &Caller) -> &str {
    match who {
        Caller::Operator => "operator",
        Caller::Session { subject, .. } => subject,
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
#[derive(Deserialize)]
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

#[path = "secret_config_mutations.rs"]
mod mutations;
pub use mutations::{branch, delete, delete_secret, put_secrets, rollback};

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
    if let Err(response) = access::project(
        &st,
        &who,
        &organization_id,
        &project_id,
        ResourcePermission::Metadata,
    )
    .await
    {
        return response;
    }
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
        Err(e) => broker_error(&e),
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
    if let Err(response) = access::project(
        &st,
        &who,
        &organization_id,
        &project_id,
        ResourcePermission::Manage,
    )
    .await
    {
        return response;
    }
    if let Some(parent_id) = body.parent_config_id.as_deref() {
        match access::config(
            &st,
            &who,
            &organization_id,
            parent_id,
            ResourcePermission::Manage,
        )
        .await
        {
            Ok(parent) if parent.project_id == project_id => {}
            _ => return access::hidden(),
        }
    }
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
            Some(actor_of(&who)),
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
        Err(e) => broker_error(&e),
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
    if let Err(response) = access::config(
        &st,
        &who,
        &organization_id,
        &id,
        ResourcePermission::Metadata,
    )
    .await
    {
        return response;
    }
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
        Err(e) => broker_error(&e),
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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Keys).await
    {
        return response;
    }
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
        Err(e) => broker_error(&e),
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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Keys).await
    {
        return response;
    }
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
        Err(e) => broker_error(&e),
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
    for id in [&a, &b] {
        if let Err(response) =
            access::config(&st, &who, &organization_id, id, ResourcePermission::Keys).await
        {
            return response;
        }
    }
    let org = organization_id.to_string();
    let left = match st.connection_broker.config_key_meta(&org, &a).await {
        Ok(keys) => keys,
        Err(e) => return broker_error(&e),
    };
    let right = match st.connection_broker.config_key_meta(&org, &b).await {
        Ok(keys) => keys,
        Err(e) => return broker_error(&e),
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

#[cfg(test)]
#[path = "secret_configs_tests.rs"]
mod tests;
