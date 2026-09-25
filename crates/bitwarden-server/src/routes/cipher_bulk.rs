//! Bulk cipher operations, purge, and import.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenFolder;
use serde_json::{Map, Value};

use super::accounts::prove_password;
use super::ciphers::new_cipher;
use super::folders::list_json;
use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{cipher_json, folder_name, normalize, parse_cipher};
use crate::BitwardenServer;

/// Bitwarden caps a bulk request at 500 ids.
const BULK_LIMIT: usize = 500;
/// The most ciphers, folders and relationships one import may carry.
const IMPORT_CIPHERS: usize = 7_000;
const IMPORT_FOLDERS: usize = 2_000;

fn ids(body: &Map<String, Value>) -> ApiResult<Vec<String>> {
    let ids: Vec<String> = body
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if ids.len() > BULK_LIMIT {
        return Err(ApiError::bad_request(format!(
            "You can only process up to {BULK_LIMIT} items at once."
        )));
    }
    Ok(ids)
}

/// `PUT /api/ciphers/delete`: to the trash.
pub async fn trash_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let now = Utc::now();
    let ids = ids(&normalize(body))?;
    server
        .db
        .bitwarden_trash_ciphers(&user.id, &ids, Some(now), now)
        .await?;
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `DELETE /api/ciphers` and `POST /api/ciphers/delete`: permanent.
pub async fn delete_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let ids = ids(&normalize(body))?;
    server.db.bitwarden_delete_ciphers(&user.id, &ids).await?;
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `PUT /api/ciphers/restore`: answers with the restored ciphers.
pub async fn restore_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ids = ids(&normalize(body))?;
    server
        .db
        .bitwarden_trash_ciphers(&user.id, &ids, None, Utc::now())
        .await?;
    touch(&server, &user.id).await?;
    let restored: Vec<Value> = server
        .db
        .bitwarden_ciphers_by_ids(&user.id, &ids)
        .await?
        .iter()
        .map(cipher_json)
        .collect();
    Ok(Json(list_json(&restored)))
}

/// `PUT /api/ciphers/move`: `{ids, folderId}`.
pub async fn move_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let ids = ids(&body)?;
    let folder = body
        .get("folderId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let folder = super::ciphers::owned_folder(&server, &user.id, folder).await?;
    server
        .db
        .bitwarden_move_ciphers(&user.id, &ids, folder.as_deref(), Utc::now())
        .await?;
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `POST /api/ciphers/purge`: every cipher and folder, after the password.
pub async fn purge(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    prove_password(&server, &user, &normalize(body)).await?;
    server.db.bitwarden_purge(&user.id).await?;
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `POST /api/ciphers/import`: `{ciphers, folders, folderRelationships}`,
/// where each relationship pairs a cipher index (`key`) with a folder index
/// (`value`). All of it lands in one transaction or none of it does.
pub async fn import(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let mut body = normalize(body);
    let count = |key: &str| body.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    if count("ciphers") > IMPORT_CIPHERS
        || count("folderRelationships") > IMPORT_CIPHERS
        || count("folders") > IMPORT_FOLDERS
    {
        return Err(ApiError::bad_request(format!(
            "You cannot import more than {IMPORT_CIPHERS} items or {IMPORT_FOLDERS} folders at once."
        )));
    }
    // Taken out of the body, not cloned: an import can be 32 MiB.
    let mut array = |key: &str| match body.remove(key) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    let now = Utc::now();
    let folders = array("folders")
        .into_iter()
        .map(|folder| {
            Ok(BitwardenFolder {
                id: uuid::Uuid::new_v4().to_string(),
                user_id: user.id.clone(),
                name: folder_name(folder)?,
                created_at: now,
                revision_at: now,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let mut ciphers = array("ciphers")
        .into_iter()
        .map(|cipher| {
            let mut input = parse_cipher(cipher, &user.id)?;
            // Imported ciphers take their folder from the relationships only.
            input.folder_id = None;
            Ok(new_cipher(&user, input, now))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    for relationship in array("folderRelationships") {
        let relationship = normalize(relationship);
        let index = |key: &str| {
            relationship
                .get(key)
                .and_then(Value::as_u64)
                .and_then(|i| usize::try_from(i).ok())
        };
        let (Some(cipher), Some(folder)) = (index("key"), index("value")) else {
            return Err(ApiError::bad_request("Invalid folder relationship."));
        };
        let folder_id = folders
            .get(folder)
            .map(|f| f.id.clone())
            .ok_or_else(|| ApiError::bad_request("Invalid folder relationship."))?;
        ciphers
            .get_mut(cipher)
            .ok_or_else(|| ApiError::bad_request("Invalid folder relationship."))?
            .folder_id = Some(folder_id);
    }
    server.db.bitwarden_import(&folders, &ciphers).await?;
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}
