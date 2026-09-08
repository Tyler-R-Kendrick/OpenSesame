use super::{
    access, actor_of, assert_no_secret_fields, authorize_write, broker_error, caller_organization,
    BranchBody, PutSecretsBody, RollbackBody,
};
use crate::app_state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{config_access::ResourcePermission, CreateSecretConfig};
use serde_json::json;

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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Manage).await
    {
        return response;
    }
    match st
        .connection_broker
        .delete_secret_config(&organization_id.to_string(), &id, Some(actor_of(&who)))
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(&e),
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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Manage).await
    {
        return response;
    }
    match st
        .connection_broker
        .put_config_secrets(
            &organization_id.to_string(),
            &id,
            &body.secrets,
            Some(actor_of(&who)),
        )
        .await
    {
        Ok(keys) => {
            // SYNC_ACTOR: the mutation appended `sync.config.dirty` rows in the
            // same transaction; wake the actor so fan-out starts immediately.
            st.sync_notify.notify_one();
            let body = json!({ "keys": keys });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(&e),
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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Manage).await
    {
        return response;
    }
    match st
        .connection_broker
        .delete_config_secret(
            &organization_id.to_string(),
            &id,
            &key,
            Some(actor_of(&who)),
        )
        .await
    {
        Ok(()) => {
            // SYNC_ACTOR: tombstone appended `sync.config.dirty`; wake the actor.
            st.sync_notify.notify_one();
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => broker_error(&e),
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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Manage).await
    {
        return response;
    }
    match st
        .connection_broker
        .rollback_config_secret(
            &organization_id.to_string(),
            &id,
            &key,
            body.to_version,
            Some(actor_of(&who)),
        )
        .await
    {
        Ok(new_version) => {
            // SYNC_ACTOR: rollback wrote a new head version and appended
            // `sync.config.dirty`; wake the actor.
            st.sync_notify.notify_one();
            let body = json!({ "key_name": key, "version": new_version });
            if let Err(resp) = assert_no_secret_fields(&body) {
                return resp;
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => broker_error(&e),
    }
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
    if let Err(response) =
        access::config(&st, &who, &organization_id, &id, ResourcePermission::Manage).await
    {
        return response;
    }
    let org = organization_id.to_string();
    let parent = match st.connection_broker.get_secret_config_view(&org, &id).await {
        Ok(view) => view,
        Err(e) => return broker_error(&e),
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
