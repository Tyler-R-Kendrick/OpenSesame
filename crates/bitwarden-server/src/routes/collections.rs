//! Collections (ADR 0148 §5): `/api/collections`, the ones the account
//! reaches, and `/api/organizations/{id}/collections`, an organization's,
//! created, renamed, reassigned and deleted by those it lets.
//!
//! Only owners, admins and custom roles allowed to create collections make
//! one (Bitwarden's "limit collection creation"); a collection is renamed or
//! reassigned by whoever manages it, and deleted by an owner or admin, a
//! custom role allowed to delete any, or a member who manages it.

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenCollection, BitwardenCollectionAccess};
use serde_json::{Map, Value};

use super::credentials::text;
use super::folders::list_json;
use super::touch_org;
use super::vault_view::{membership, OrgView, VaultView};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize};
use crate::wire::org::{collection_access_details, collection_details, collection_json, selection};
use crate::BitwardenServer;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route("/collections", get(mine))
        .route(
            "/organizations/{org}/collections",
            get(list).post(create).delete(remove_many),
        )
        .route(
            "/organizations/{org}/collections/details",
            get(list_details),
        )
        .route("/organizations/{org}/collections/delete", post(remove_many))
        .route(
            "/organizations/{org}/collections/{id}",
            get(get_one).put(update).post(update).delete(remove_one),
        )
        .route(
            "/organizations/{org}/collections/{id}/details",
            get(details_one),
        )
        .route(
            "/organizations/{org}/collections/{id}/delete",
            post(remove_one),
        )
        .route(
            "/organizations/{org}/collections/{id}/users",
            get(users).put(set_users),
        )
}

/// Owners, admins and custom roles that see every collection.
fn sees_all(view: &OrgView) -> bool {
    view.admin
}

fn visible(view: &OrgView) -> Vec<&BitwardenCollection> {
    view.collections
        .iter()
        .filter(|c| view.collection_rights(&c.id).is_some())
        .collect()
}

/// `GET /collections`: every collection of every organization the account
/// is a confirmed member of that it reaches, with how.
async fn mine(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    Ok(Json(list_json(&for_sync(
        &VaultView::load(&server, &user.id).await?,
    ))))
}

/// The collections a sync carries.
pub(crate) fn for_sync(view: &VaultView) -> Vec<Value> {
    let mut out = Vec::new();
    for org in view.orgs.values() {
        for collection in visible(org) {
            if let Some(rights) = org.collection_rights(&collection.id) {
                out.push(collection_details(collection, rights));
            }
        }
    }
    out
}

/// `GET /organizations/{id}/collections`.
async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    let out: Vec<Value> = visible(&view).into_iter().map(collection_json).collect();
    Ok(Json(list_json(&out)))
}

async fn access_view(
    server: &BitwardenServer,
    view: &OrgView,
    collections: &[&BitwardenCollection],
) -> ApiResult<Vec<Value>> {
    let access = server.db.bitwarden_collection_access(&view.org.id).await?;
    Ok(collections
        .iter()
        .map(|c| collection_access_details(c, &access, view.my_access.get(&c.id)))
        .collect())
}

/// `GET /organizations/{id}/collections/details`.
async fn list_details(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    let out = access_view(&server, &view, &visible(&view)).await?;
    Ok(Json(list_json(&out)))
}

fn reach<'a>(view: &'a OrgView, id: &str) -> ApiResult<&'a BitwardenCollection> {
    visible(view)
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(ApiError::not_found)
}

/// `GET /organizations/{id}/collections/{collection}`.
async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    Ok(Json(collection_json(reach(&view, &id)?)))
}

/// `GET /organizations/{id}/collections/{collection}/details`.
async fn details_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    let collection = reach(&view, &id)?;
    let mut out = access_view(&server, &view, &[collection]).await?;
    Ok(Json(out.pop().unwrap_or_default()))
}

/// `[{id, readOnly, hidePasswords, manage}]`, each naming a member of the
/// organization.
async fn member_access(
    server: &BitwardenServer,
    org: &str,
    collection_id: &str,
    items: Option<&Value>,
) -> ApiResult<Vec<BitwardenCollectionAccess>> {
    let members: HashSet<String> = server
        .db
        .bitwarden_org_members(org)
        .await?
        .into_iter()
        .map(|m| m.id)
        .collect();
    let flag = |item: &Map<String, Value>, key: &str| {
        item.get(key).and_then(Value::as_bool).unwrap_or(false)
    };
    let mut out = Vec::new();
    for item in items.and_then(Value::as_array).into_iter().flatten() {
        let item = normalize(item.clone());
        let id = text(&item, "id").unwrap_or_default();
        if !members.contains(&id) {
            return Err(ApiError::bad_request(
                "A member does not belong to this organization.",
            ));
        }
        out.push(BitwardenCollectionAccess {
            collection_id: collection_id.to_owned(),
            member_id: id,
            read_only: flag(&item, "readOnly"),
            hide_passwords: flag(&item, "hidePasswords"),
            manage: flag(&item, "manage"),
        });
    }
    Ok(out)
}

fn encrypted_name(body: &Map<String, Value>) -> ApiResult<String> {
    text(body, "name")
        .filter(|n| is_enc_string(n))
        .ok_or_else(|| ApiError::bad_request("The collection name must be encrypted."))
}

/// `POST /organizations/{id}/collections`: `{name, externalId, users, groups}`.
async fn create(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    if !(view.manages() || super::vault_view::permitted(&view.member, "createNewCollections")) {
        return Err(ApiError::bad_request("You may not create collections."));
    }
    let body = normalize(body);
    let now = Utc::now();
    let collection = BitwardenCollection {
        id: uuid::Uuid::new_v4().to_string(),
        org_id: org.clone(),
        name: encrypted_name(&body)?,
        external_id: text(&body, "externalId").filter(|e| !e.is_empty()),
        created_at: now,
        revision_at: now,
    };
    let access = member_access(&server, &org, &collection.id, body.get("users")).await?;
    server
        .db
        .bitwarden_create_collection(&collection, &access)
        .await?;
    touch_org(&server, &org).await?;
    let view = membership(&server, &user.id, &org).await?;
    let mut out = access_view(&server, &view, &[&collection]).await?;
    Ok(Json(out.pop().unwrap_or_default()))
}

/// Whether the member manages this collection: an administrator, or a
/// member given `manage` on it.
fn manages(view: &OrgView, id: &str) -> bool {
    sees_all(view)
        || view
            .collection_rights(id)
            .is_some_and(|(_, _, manage)| manage)
}

/// `PUT /organizations/{id}/collections/{collection}`: rename it and, when
/// `users` is sent, replace who reaches it.
async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    let mut collection = reach(&view, &id)?.clone();
    if !manages(&view, &id) {
        return Err(ApiError::bad_request("You may not change this collection."));
    }
    let body = normalize(body);
    collection.name = encrypted_name(&body)?;
    collection.external_id = text(&body, "externalId").filter(|e| !e.is_empty());
    collection.revision_at = Utc::now();
    let access = match body.get("users").filter(|u| !u.is_null()) {
        Some(users) => Some(member_access(&server, &org, &id, Some(users)).await?),
        None => None,
    };
    server
        .db
        .bitwarden_update_collection(&collection, access.as_deref())
        .await?;
    touch_org(&server, &org).await?;
    let view = membership(&server, &user.id, &org).await?;
    let mut out = access_view(&server, &view, &[&collection]).await?;
    Ok(Json(out.pop().unwrap_or_default()))
}

/// `GET …/{collection}/users`: who reaches it.
async fn users(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    reach(&view, &id)?;
    let access = server.db.bitwarden_collection_access(&org).await?;
    let out: Vec<Value> = access
        .iter()
        .filter(|a| a.collection_id == id)
        .map(|a| selection(&a.member_id, a))
        .collect();
    Ok(Json(Value::Array(out)))
}

/// `PUT …/{collection}/users`: replace who reaches it.
async fn set_users(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let view = membership(&server, &user.id, &org).await?;
    let mut collection = reach(&view, &id)?.clone();
    if !manages(&view, &id) {
        return Err(ApiError::bad_request("You may not change this collection."));
    }
    let access = member_access(&server, &org, &id, Some(&body)).await?;
    collection.revision_at = Utc::now();
    server
        .db
        .bitwarden_update_collection(&collection, Some(&access))
        .await?;
    touch_org(&server, &org).await?;
    Ok(StatusCode::OK)
}

async fn delete(server: &BitwardenServer, view: &OrgView, ids: &[String]) -> ApiResult<()> {
    let allowed = |id: &String| {
        view.collections.iter().any(|c| &c.id == id)
            && (manages(view, id)
                || super::vault_view::permitted(&view.member, "deleteAnyCollection"))
    };
    if !ids.iter().all(allowed) {
        return Err(ApiError::bad_request("You may not delete this collection."));
    }
    server
        .db
        .bitwarden_delete_collections(&view.org.id, ids)
        .await?;
    touch_org(server, &view.org.id).await?;
    Ok(())
}

/// `DELETE /organizations/{id}/collections/{collection}`.
async fn remove_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let view = membership(&server, &user.id, &org).await?;
    delete(&server, &view, &[id]).await?;
    Ok(StatusCode::OK)
}

/// `DELETE /organizations/{id}/collections`: `{ids}`.
async fn remove_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let view = membership(&server, &user.id, &org).await?;
    let ids: Vec<String> = normalize(body)
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    delete(&server, &view, &ids).await?;
    Ok(StatusCode::OK)
}
