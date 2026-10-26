//! Organization ciphers (ADR 0148 §5): creating one in an organization,
//! sharing a personal cipher into one, putting a cipher in collections,
//! the administrators' views, and importing into an organization.
//!
//! Every check goes through `vault_view`: a member writes only into
//! collections that are not read-only for them, and changes a cipher's
//! collections only when they manage it. Collections a member cannot see
//! stay on a cipher whatever they send.

use std::collections::HashSet;

use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenAttachment, BitwardenMark, BitwardenUser};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::ciphers::{new_cipher, owned_folder};
use super::folders::list_json;
use super::org_share::{share, share_many};
use super::vault_view::{membership, render_one, VaultView};
use super::{attachments, cipher_bulk, ciphers, touch_org};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize, parse_cipher_for};
use crate::BitwardenServer;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route(
            "/ciphers/admin",
            post(ciphers::create_with_collections).delete(cipher_bulk::delete_many),
        )
        .route(
            "/ciphers/{id}/admin",
            get(ciphers::get_one)
                .put(ciphers::update)
                .post(ciphers::update)
                .delete(ciphers::delete_one),
        )
        .route(
            "/ciphers/{id}/delete-admin",
            put(ciphers::trash_one).post(ciphers::delete_one),
        )
        .route(
            "/ciphers/delete-admin",
            put(cipher_bulk::trash_many).post(cipher_bulk::delete_many),
        )
        .route("/ciphers/{id}/restore-admin", put(ciphers::restore_one))
        .route("/ciphers/restore-admin", put(cipher_bulk::restore_many))
        .route(
            "/ciphers/{id}/attachment/{attachment}/admin",
            delete(attachments::remove),
        )
        .route("/ciphers/{id}/share", put(share).post(share))
        .route("/ciphers/share", put(share_many).post(share_many))
        .route(
            "/ciphers/{id}/collections",
            put(set_collections).post(set_collections),
        )
        .route(
            "/ciphers/{id}/collections-admin",
            put(set_collections).post(set_collections),
        )
        .route(
            "/ciphers/{id}/collections_v2",
            put(set_collections_v2).post(set_collections_v2),
        )
        .route("/ciphers/organization-details", get(organization_details))
        .route(
            "/ciphers/organization-details/assigned",
            get(organization_details),
        )
}

/// `collectionIds` from a request body.
pub(crate) fn collection_ids(body: &Map<String, Value>) -> Vec<String> {
    body.get("collectionIds")
        .and_then(Value::as_array)
        .map(|ids| {
            let mut seen = HashSet::new();
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| seen.insert(*id))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn no_permission() -> ApiError {
    ApiError::bad_request("You do not have permissions to edit this.")
}

/// Create a cipher in an organization, in `collections`; its folder and
/// favourite are the creator's own.
pub(crate) async fn create(
    server: &BitwardenServer,
    user: &BitwardenUser,
    org: &str,
    body: Value,
    collections: &[String],
) -> ApiResult<Json<Value>> {
    let view = membership(server, &user.id, org).await?;
    if !view.admin && collections.is_empty() {
        return Err(ApiError::bad_request(
            "You must select at least one collection.",
        ));
    }
    if !view.can_write_to(collections) {
        return Err(no_permission());
    }
    let mut input = parse_cipher_for(body, &user.id, Some(org))?;
    let mark = BitwardenMark {
        folder_id: owned_folder(server, &user.id, input.folder_id.take()).await?,
        favorite: input.favorite,
    };
    let mut cipher = new_cipher(user, input, Utc::now());
    cipher.user_id = None;
    cipher.organization_id = Some(org.to_owned());
    cipher.favorite = false;
    server
        .db
        .bitwarden_insert_org_cipher(&cipher, collections, &user.id, &mark)
        .await?;
    touch_org(server, org).await?;
    Ok(Json(render_one(server, &user.id, &cipher.id).await?))
}

/// Put an organization cipher in exactly `requested`, as far as the account
/// may: it must manage the cipher, may add only collections it can write
/// to, and leaves those it cannot see as they are.
async fn put_collections(
    server: &BitwardenServer,
    user_id: &str,
    id: &str,
    requested: &[String],
) -> ApiResult<()> {
    let view = VaultView::load(server, user_id).await?;
    let (cipher, rights) = view.reach(id)?;
    let org_id = cipher
        .organization_id
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("The cipher is not in an organization."))?;
    let org = view.orgs.get(org_id).ok_or_else(ApiError::not_found)?;
    if !(org.admin || rights.manage) {
        return Err(no_permission());
    }
    let current: HashSet<&String> = org
        .cipher_collections
        .get(id)
        .into_iter()
        .flatten()
        .collect();
    let added: Vec<String> = requested
        .iter()
        .filter(|c| !current.contains(c))
        .cloned()
        .collect();
    if !org.can_write_to(&added) || requested.iter().any(|c| org.collection_rights(c).is_none()) {
        return Err(no_permission());
    }
    let mut next: Vec<String> = requested.to_vec();
    next.extend(
        current
            .iter()
            .filter(|c| org.collection_rights(c).is_none())
            .map(|c| (*c).clone()),
    );
    if !org.admin && next.is_empty() {
        return Err(ApiError::bad_request(
            "You must select at least one collection.",
        ));
    }
    server
        .db
        .bitwarden_set_cipher_collections(id, &next, Utc::now())
        .await?;
    touch_org(server, org_id).await?;
    Ok(())
}

/// `PUT /ciphers/{id}/collections`: `{collectionIds}`.
async fn set_collections(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    put_collections(&server, &user.id, &id, &collection_ids(&normalize(body))).await?;
    let view = VaultView::load(&server, &user.id).await?;
    Ok(Json(view.find(&id).map_or(Value::Null, |c| view.render(c))))
}

/// `PUT /ciphers/{id}/collections_v2`: as above, answering whether the
/// account still sees the cipher afterwards.
async fn set_collections_v2(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    put_collections(&server, &user.id, &id, &collection_ids(&normalize(body))).await?;
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.find(&id).map(|c| view.render(c));
    Ok(Json(json!({
        "unavailable": cipher.is_none(),
        "cipher": cipher,
        "object": "optionalCipherDetails",
    })))
}

#[derive(Deserialize)]
pub struct OrgQuery {
    #[serde(rename = "organizationId")]
    pub(crate) organization_id: String,
}

/// `GET /ciphers/organization-details?organizationId=`: the organization's
/// ciphers the account reaches — all of them for an administrator.
async fn organization_details(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Query(query): Query<OrgQuery>,
) -> ApiResult<Json<Value>> {
    membership(&server, &user.id, &query.organization_id).await?;
    let view = VaultView::load(&server, &user.id).await?;
    let ciphers: Vec<Value> = view
        .ciphers
        .iter()
        .filter(|c| c.organization_id.as_deref() == Some(query.organization_id.as_str()))
        .map(|c| view.render(c))
        .collect();
    Ok(Json(list_json(&ciphers)))
}

/// `POST /ciphers/{id}/attachment/{attachmentId}/share?organizationId=`:
/// a file of one of the account's own ciphers, re-encrypted under the
/// organization key before the cipher is shared.
pub async fn share_attachment(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
    Query(query): Query<OrgQuery>,
    form: Multipart,
) -> ApiResult<StatusCode> {
    membership(&server, &user.id, &query.organization_id).await?;
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view
        .find(&cipher_id)
        .filter(|c| c.user_id.as_deref() == Some(user.id.as_str()))
        .ok_or_else(ApiError::not_found)?;
    let existing = server
        .db
        .bitwarden_attachment_of(&cipher.id, &id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let (data, key, name) = attachments::read_upload(form).await?;
    let size = i64::try_from(data.len()).unwrap_or(i64::MAX);
    if size.abs_diff(existing.size) > attachments::SIZE_LEEWAY.unsigned_abs() {
        return Err(ApiError::bad_request("File size does not match."));
    }
    let (Some(key), file_name) = (
        key.filter(|k| is_enc_string(k)),
        name.filter(|n| is_enc_string(n))
            .unwrap_or(existing.file_name.clone()),
    ) else {
        return Err(ApiError::bad_request("The file key must be encrypted."));
    };
    attachments::admit(&server, 0, size)?;
    let replacement = BitwardenAttachment {
        file_name,
        key: Some(key),
        size,
        uploaded: true,
        ..existing
    };
    if !server
        .db
        .bitwarden_rekey_attachment(&replacement, &data, server.config.storage_quota_bytes)
        .await?
    {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::OK)
}
