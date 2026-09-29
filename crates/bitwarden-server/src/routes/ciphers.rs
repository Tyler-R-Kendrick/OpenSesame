//! `/api/ciphers/{id}` and single-cipher writes, for the account's own
//! ciphers and the organization ciphers it reaches (`vault_view`).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use opensesame_storage::bitwarden::{BitwardenCipher, BitwardenMark, BitwardenUser};
use serde_json::Value;

use super::folders::list_json;
use super::vault_view::{render_one, VaultView};
use super::{touch, touch_cipher};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{normalize, parse_cipher, parse_cipher_for, CipherInput};
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
        user_id: Some(user.id.clone()),
        organization_id: None,
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

pub async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let view = VaultView::load(&server, &user.id).await?;
    Ok(Json(list_json(&view.rendered())))
}

pub async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(render_one(&server, &user.id, &id).await?))
}

async fn insert(
    server: &BitwardenServer,
    user: &BitwardenUser,
    body: Value,
) -> ApiResult<Json<Value>> {
    super::policy_rules::may_own_items(server, &user.id).await?;
    let mut input = parse_cipher(body, &user.id)?;
    input.folder_id = owned_folder(server, &user.id, input.folder_id.take()).await?;
    let cipher = new_cipher(user, input, Utc::now());
    server.db.bitwarden_insert_cipher(&cipher).await?;
    touch(server, &user.id).await?;
    Ok(Json(render_one(server, &user.id, &cipher.id).await?))
}

pub(crate) const OUT_OF_DATE: &str =
    "The cipher you are updating is out of date. Please save your work, sync your vault, and try again.";

/// Write a personal `cipher` only if it is still at the revision it was read
/// at, then answer with what was stored.
async fn replace(
    server: &BitwardenServer,
    user_id: &str,
    mut cipher: BitwardenCipher,
) -> ApiResult<Json<Value>> {
    let read_at = cipher.revision_at;
    cipher.revision_at = Utc::now();
    if !server.db.bitwarden_update_cipher(&cipher, read_at).await? {
        return Err(ApiError::bad_request(OUT_OF_DATE));
    }
    touch(server, user_id).await?;
    Ok(Json(render_one(server, user_id, &cipher.id).await?))
}

/// `POST /api/ciphers`: a personal cipher.
pub async fn create(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    insert(&server, &user, body).await
}

/// `POST /api/ciphers/create`: `{cipher, collectionIds}`. A cipher naming an
/// organization is created in it, in collections the account may write to.
pub async fn create_with_collections(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let cipher = body.get("cipher").cloned().unwrap_or(Value::Null);
    let org = normalize(cipher.clone())
        .get("organizationId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let Some(org) = org else {
        return insert(&server, &user, cipher).await;
    };
    let collections = super::org_ciphers::collection_ids(&body);
    super::org_ciphers::create(&server, &user, &org, cipher, &collections).await
}

/// Update an organization cipher the account may edit; its folder and
/// favourite are the account's own.
async fn update_org(
    server: &BitwardenServer,
    user: &BitwardenUser,
    mut cipher: BitwardenCipher,
    body: Value,
) -> ApiResult<Json<Value>> {
    let org = cipher.organization_id.clone().unwrap_or_default();
    let input = parse_cipher_for(body, &user.id, Some(&org))?;
    if let Some(known) = input.last_known_revision {
        if (cipher.revision_at - known).num_milliseconds().abs() > 1_000 {
            return Err(ApiError::bad_request(OUT_OF_DATE));
        }
    }
    let read_at = cipher.revision_at;
    cipher.cipher_type = input.cipher_type;
    cipher.data = input.data.to_string();
    cipher.revision_at = Utc::now();
    if !server
        .db
        .bitwarden_update_org_cipher(&cipher, read_at)
        .await?
    {
        return Err(ApiError::bad_request(OUT_OF_DATE));
    }
    let mark = BitwardenMark {
        folder_id: owned_folder(server, &user.id, input.folder_id).await?,
        favorite: input.favorite,
    };
    server
        .db
        .bitwarden_set_mark(&cipher.id, &user.id, &mark)
        .await?;
    touch_cipher(server, &cipher).await?;
    Ok(Json(render_one(server, &user.id, &cipher.id).await?))
}

/// `PUT /api/ciphers/{id}`. A client that edited a stale copy is refused,
/// with Bitwarden's wording, rather than silently overwriting a newer one.
pub async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let view = VaultView::load(&server, &user.id).await?;
    let mut cipher = view.reach_to_edit(&id)?.clone();
    if cipher.organization_id.is_some() {
        return update_org(&server, &user, cipher, body).await;
    }
    let mut input = parse_cipher(body, &user.id)?;
    if let Some(known) = input.last_known_revision {
        if (cipher.revision_at - known).num_milliseconds().abs() > 1_000 {
            return Err(ApiError::bad_request(OUT_OF_DATE));
        }
    }
    cipher.folder_id = owned_folder(&server, &user.id, input.folder_id.take()).await?;
    cipher.cipher_type = input.cipher_type;
    cipher.favorite = input.favorite;
    cipher.data = input.data.to_string();
    replace(&server, &user.id, cipher).await
}

/// `PUT /api/ciphers/{id}/partial`: folder and favorite only — the account's
/// own, even on an organization cipher it may not edit.
pub async fn partial(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let view = VaultView::load(&server, &user.id).await?;
    let (cipher, _) = view.reach(&id)?;
    let folder_id = body
        .get("folderId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let folder_id = owned_folder(&server, &user.id, folder_id).await?;
    let favorite = body
        .get("favorite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if cipher.organization_id.is_some() {
        let mark = BitwardenMark {
            folder_id,
            favorite,
        };
        server
            .db
            .bitwarden_set_mark(&cipher.id, &user.id, &mark)
            .await?;
        touch(&server, &user.id).await?;
        return Ok(Json(render_one(&server, &user.id, &id).await?));
    }
    let mut cipher = cipher.clone();
    cipher.folder_id = folder_id;
    cipher.favorite = favorite;
    replace(&server, &user.id, cipher).await
}

/// Trash (`Some`) or restore (`None`) one cipher the account may change.
async fn set_trashed(
    server: &BitwardenServer,
    user: &BitwardenUser,
    id: &str,
    at: Option<DateTime<Utc>>,
) -> ApiResult<BitwardenCipher> {
    let view = VaultView::load(server, &user.id).await?;
    let cipher = view.reach_to_edit(id)?.clone();
    let now = Utc::now();
    let ids = [id.to_owned()];
    let changed = if cipher.organization_id.is_some() {
        server.db.bitwarden_trash_org_ciphers(&ids, at, now).await?
    } else {
        server
            .db
            .bitwarden_trash_ciphers(&user.id, &ids, at, now)
            .await?
    };
    if changed == 0 {
        return Err(ApiError::not_found());
    }
    touch_cipher(server, &cipher).await?;
    Ok(cipher)
}

/// `DELETE /api/ciphers/{id}`: permanent.
pub async fn delete_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.reach_to_edit(&id)?.clone();
    let ids = [id];
    if cipher.organization_id.is_some() {
        server.db.bitwarden_delete_org_ciphers(&ids).await?;
    } else {
        server.db.bitwarden_delete_ciphers(&user.id, &ids).await?;
    }
    touch_cipher(&server, &cipher).await?;
    Ok(StatusCode::OK)
}

/// `PUT /api/ciphers/{id}/delete`: to the trash.
pub async fn trash_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    set_trashed(&server, &user, &id, Some(Utc::now())).await?;
    Ok(StatusCode::OK)
}

/// `PUT /api/ciphers/{id}/restore`: out of the trash.
pub async fn restore_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    set_trashed(&server, &user, &id, None).await?;
    Ok(Json(render_one(&server, &user.id, &id).await?))
}
