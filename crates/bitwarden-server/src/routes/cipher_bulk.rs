//! Bulk cipher operations, purge, and import.

use std::collections::HashSet;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenFolder;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::accounts::prove_password;
use super::ciphers::new_cipher;
use super::folders::list_json;
use super::vault_view::VaultView;
use super::{touch, touch_org};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{folder_name, normalize, parse_cipher};
use crate::BitwardenServer;

/// Bitwarden caps a bulk request at 500 ids.
const BULK_LIMIT: usize = 500;
/// The most ciphers, folders and relationships one import may carry.
pub(crate) const IMPORT_CIPHERS: usize = 7_000;
pub(crate) const IMPORT_FOLDERS: usize = 2_000;

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

/// The ids the account may change, split into its own and organization
/// ciphers; anything else is silently left alone, as Bitwarden does.
fn split(view: &VaultView, ids: &[String]) -> (Vec<String>, Vec<String>, HashSet<String>) {
    let (mut own, mut org, mut orgs) = (Vec::new(), Vec::new(), HashSet::new());
    for id in ids {
        let Ok(cipher) = view.reach_to_edit(id) else {
            continue;
        };
        match &cipher.organization_id {
            Some(org_id) => {
                org.push(id.clone());
                orgs.insert(org_id.clone());
            }
            None => own.push(id.clone()),
        }
    }
    (own, org, orgs)
}

async fn touch_all(
    server: &BitwardenServer,
    user_id: &str,
    orgs: &HashSet<String>,
) -> ApiResult<()> {
    touch(server, user_id).await?;
    for org in orgs {
        touch_org(server, org).await?;
    }
    Ok(())
}

async fn set_trashed(
    server: &BitwardenServer,
    user_id: &str,
    ids: &[String],
    at: Option<chrono::DateTime<Utc>>,
) -> ApiResult<()> {
    let view = VaultView::load(server, user_id).await?;
    let (own, org, orgs) = split(&view, ids);
    let now = Utc::now();
    server
        .db
        .bitwarden_trash_ciphers(user_id, &own, at, now)
        .await?;
    server.db.bitwarden_trash_org_ciphers(&org, at, now).await?;
    touch_all(server, user_id, &orgs).await
}

/// `PUT /api/ciphers/delete`: to the trash.
pub async fn trash_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let ids = ids(&normalize(body))?;
    set_trashed(&server, &user.id, &ids, Some(Utc::now())).await?;
    Ok(StatusCode::OK)
}

/// `DELETE /api/ciphers` and `POST /api/ciphers/delete`: permanent.
pub async fn delete_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let ids = ids(&normalize(body))?;
    let view = VaultView::load(&server, &user.id).await?;
    let (own, org, orgs) = split(&view, &ids);
    server.db.bitwarden_delete_ciphers(&user.id, &own).await?;
    server.db.bitwarden_delete_org_ciphers(&org).await?;
    touch_all(&server, &user.id, &orgs).await?;
    Ok(StatusCode::OK)
}

/// `PUT /api/ciphers/restore`: answers with the restored ciphers.
pub async fn restore_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ids = ids(&normalize(body))?;
    set_trashed(&server, &user.id, &ids, None).await?;
    let view = VaultView::load(&server, &user.id).await?;
    let restored: Vec<Value> = ids
        .iter()
        .filter_map(|id| view.find(id))
        .map(|c| view.render(c))
        .collect();
    Ok(Json(list_json(&restored)))
}

/// `PUT /api/ciphers/move`: `{ids, folderId}`. An organization cipher's
/// folder is the account's own, so it moves for this account only.
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
    let view = VaultView::load(&server, &user.id).await?;
    let mut own = Vec::new();
    for id in &ids {
        let Some(cipher) = view.find(id) else {
            continue;
        };
        if cipher.organization_id.is_some() {
            let mut mark = view.mark(id);
            mark.folder_id.clone_from(&folder);
            server.db.bitwarden_set_mark(id, &user.id, &mark).await?;
        } else {
            own.push(id.clone());
        }
    }
    server
        .db
        .bitwarden_move_ciphers(&user.id, &own, folder.as_deref(), Utc::now())
        .await?;
    touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct PurgeQuery {
    #[serde(default, rename = "organizationId")]
    organization_id: Option<String>,
}

/// `POST /api/ciphers/purge`: every cipher and folder, after the password;
/// with `?organizationId=`, every cipher of that organization, by its owner.
pub async fn purge(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Query(query): Query<PurgeQuery>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    prove_password(&server, &user, &normalize(body)).await?;
    if let Some(org) = query.organization_id.filter(|id| !id.is_empty()) {
        let view = super::vault_view::membership(&server, &user.id, &org).await?;
        if !view.is_owner() {
            return Err(ApiError::not_found());
        }
        server.db.bitwarden_purge_org(&org).await?;
        touch_org(&server, &org).await?;
        return Ok(StatusCode::OK);
    }
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
    super::policy_rules::may_own_items(&server, &user.id).await?;
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
