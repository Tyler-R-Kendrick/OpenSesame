//! `/api/folders`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenFolder;
use serde_json::{json, Value};

use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{folder_json, folder_name};
use crate::BitwardenServer;

/// Bitwarden's list envelope.
pub fn list_json(data: &[Value]) -> Value {
    json!({ "data": data, "object": "list", "continuationToken": null })
}

pub async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let folders = server.db.bitwarden_folders(&user.id).await?;
    Ok(Json(list_json(
        &folders.iter().map(folder_json).collect::<Vec<_>>(),
    )))
}

pub async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let folder = server
        .db
        .bitwarden_folder(&user.id, &id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(Json(folder_json(&folder)))
}

pub async fn create(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let name = folder_name(body)?;
    let now = Utc::now();
    let folder = BitwardenFolder {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user.id.clone(),
        name,
        created_at: now,
        revision_at: now,
    };
    server.db.bitwarden_put_folder(&folder).await?;
    touch(&server, &user.id).await?;
    Ok(Json(folder_json(&folder)))
}

pub async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut folder = server
        .db
        .bitwarden_folder(&user.id, &id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    folder.name = folder_name(body)?;
    folder.revision_at = Utc::now();
    server.db.bitwarden_put_folder(&folder).await?;
    touch(&server, &user.id).await?;
    Ok(Json(folder_json(&folder)))
}

pub async fn remove(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if !server.db.bitwarden_delete_folder(&user.id, &id).await? {
        return Err(ApiError::not_found());
    }
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}
