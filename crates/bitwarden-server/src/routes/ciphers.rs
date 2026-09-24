//! `/api/ciphers/{id}` and single-cipher writes.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use opensesame_storage::bitwarden::{BitwardenCipher, BitwardenUser};
use serde_json::Value;

use super::folders::list_json;
use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{cipher_json, normalize, parse_cipher, CipherInput};
use crate::BitwardenServer;

/// A folder named by a write must be the caller's own.
pub(crate) async fn owned_folder(
    server: &BitwardenServer,
    user_id: &str,
    folder_id: Option<String>,
) -> ApiResult<Option<String>> {
    let Some(folder_id) = folder_id else {
        return Ok(None);
    };
    server
        .db
        .bitwarden_folder(user_id, &folder_id)
        .await?
        .map(|_| Some(folder_id))
        .ok_or_else(|| ApiError::bad_request("Invalid folder."))
}

pub(crate) fn new_cipher(
    user: &BitwardenUser,
    input: CipherInput,
    now: DateTime<Utc>,
) -> BitwardenCipher {
    BitwardenCipher {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user.id.clone(),
        folder_id: input.folder_id,
        cipher_type: input.cipher_type,
        favorite: input.favorite,
        data: input.data.to_string(),
        created_at: now,
        revision_at: now,
        deleted_at: None,
        archived_at: None,
    }
}

async fn owned(server: &BitwardenServer, user_id: &str, id: &str) -> ApiResult<BitwardenCipher> {
    server
        .db
        .bitwarden_cipher(user_id, id)
        .await?
        .ok_or_else(ApiError::not_found)
}

pub async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let ciphers = server.db.bitwarden_ciphers(&user.id).await?;
    Ok(Json(list_json(
        &ciphers.iter().map(cipher_json).collect::<Vec<_>>(),
    )))
}

pub async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(cipher_json(&owned(&server, &user.id, &id).await?)))
}

async fn insert(
    server: &BitwardenServer,
    user: &BitwardenUser,
    body: Value,
) -> ApiResult<Json<Value>> {
    let mut input = parse_cipher(body, &user.id)?;
    input.folder_id = owned_folder(server, &user.id, input.folder_id.take()).await?;
    let cipher = new_cipher(user, input, Utc::now());
    server.db.bitwarden_put_cipher(&cipher).await?;
    touch(server, &user.id).await?;
    Ok(Json(cipher_json(&cipher)))
}

/// `POST /api/ciphers`.
pub async fn create(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    insert(&server, &user, body).await
}

/// `POST /api/ciphers/create`: `{cipher, collectionIds}`. Only a personal
/// cipher — no collections — can be created here.
pub async fn create_with_collections(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let has_collections = body
        .get("collectionIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty());
    if has_collections {
        return Err(ApiError::bad_request(
            "Organizations are not supported by this server.",
        ));
    }
    let cipher = body.get("cipher").cloned().unwrap_or(Value::Null);
    insert(&server, &user, cipher).await
}

/// `PUT /api/ciphers/{id}`. A client that edited a stale copy is refused,
/// with Bitwarden's wording, rather than silently overwriting a newer one.
pub async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut cipher = owned(&server, &user.id, &id).await?;
    let mut input = parse_cipher(body, &user.id)?;
    if let Some(known) = input.last_known_revision {
        if (cipher.revision_at - known).num_milliseconds().abs() > 1_000 {
            return Err(ApiError::bad_request(
                "The cipher you are updating is out of date. Please save your work, sync your vault, and try again.",
            ));
        }
    }
    cipher.folder_id = owned_folder(&server, &user.id, input.folder_id.take()).await?;
    cipher.cipher_type = input.cipher_type;
    cipher.favorite = input.favorite;
    cipher.data = input.data.to_string();
    cipher.revision_at = Utc::now();
    server.db.bitwarden_put_cipher(&cipher).await?;
    touch(&server, &user.id).await?;
    Ok(Json(cipher_json(&cipher)))
}

/// `PUT /api/ciphers/{id}/partial`: folder and favorite only.
pub async fn partial(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let mut cipher = owned(&server, &user.id, &id).await?;
    let folder_id = body
        .get("folderId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    cipher.folder_id = owned_folder(&server, &user.id, folder_id).await?;
    cipher.favorite = body
        .get("favorite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    cipher.revision_at = Utc::now();
    server.db.bitwarden_put_cipher(&cipher).await?;
    touch(&server, &user.id).await?;
    Ok(Json(cipher_json(&cipher)))
}

/// `DELETE /api/ciphers/{id}`: permanent.
pub async fn delete_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if server.db.bitwarden_delete_ciphers(&user.id, &[id]).await? == 0 {
        return Err(ApiError::not_found());
    }
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `PUT /api/ciphers/{id}/delete`: to the trash.
pub async fn trash_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let now = Utc::now();
    if server
        .db
        .bitwarden_trash_ciphers(&user.id, &[id], Some(now), now)
        .await?
        == 0
    {
        return Err(ApiError::not_found());
    }
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `PUT /api/ciphers/{id}/restore`: out of the trash.
pub async fn restore_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let now = Utc::now();
    let ids = [id];
    if server
        .db
        .bitwarden_trash_ciphers(&user.id, &ids, None, now)
        .await?
        == 0
    {
        return Err(ApiError::not_found());
    }
    touch(&server, &user.id).await?;
    Ok(Json(cipher_json(&owned(&server, &user.id, &ids[0]).await?)))
}
