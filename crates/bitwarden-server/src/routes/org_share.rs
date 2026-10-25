//! Validate single and bulk shares before one atomic ownership transfer.

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenCipher, BitwardenUser};
use serde_json::Value;

use super::ciphers::OUT_OF_DATE;
use super::folders::list_json;
use super::org_ciphers::collection_ids;
use super::vault_view::{render_one, VaultView};
use super::{touch, touch_org};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{normalize, parse_cipher_for};
use crate::BitwardenServer;

/// Bitwarden caps a bulk share at this many ciphers.
const SHARE_LIMIT: usize = 500;

/// Share one of the account's own ciphers into an organization.
fn prepare_share(
    user: &BitwardenUser,
    view: &VaultView,
    id: &str,
    body: Value,
    collections: &[String],
) -> ApiResult<BitwardenCipher> {
    let cipher = view
        .find(id)
        .filter(|c| c.user_id.as_deref() == Some(user.id.as_str()))
        .ok_or_else(ApiError::not_found)?;
    let org = normalize(body.clone())
        .get("organizationId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad_request("The cipher must name an organization."))?;
    let org_view = view.orgs.get(&org).ok_or_else(ApiError::not_found)?;
    if collections.is_empty() {
        return Err(ApiError::bad_request(
            "You must select at least one collection.",
        ));
    }
    if !org_view.can_write_to(collections) {
        return Err(ApiError::bad_request(
            "You do not have permissions to edit this.",
        ));
    }
    let input = parse_cipher_for(body, &user.id, Some(&org))?;
    if let Some(known) = input.last_known_revision {
        if (cipher.revision_at - known).num_milliseconds().abs() > 1_000 {
            return Err(ApiError::bad_request(OUT_OF_DATE));
        }
    }
    let mut shared = cipher.clone();
    shared.user_id = None;
    shared.organization_id = Some(org);
    shared.folder_id = None;
    shared.favorite = false;
    shared.cipher_type = input.cipher_type;
    shared.data = input.data.to_string();
    shared.revision_at = Utc::now();
    Ok(shared)
}

/// `PUT /ciphers/{id}/share`: `{cipher, collectionIds}`, the cipher
/// re-encrypted under the organization key.
pub(super) async fn share(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut body = normalize(body);
    let collections = collection_ids(&body);
    let cipher = body.remove("cipher").unwrap_or(Value::Null);
    let view = VaultView::load(&server, &user.id).await?;
    let shared = prepare_share(&user, &view, &id, cipher, &collections)?;
    let org = shared
        .organization_id
        .as_deref()
        .ok_or_else(ApiError::not_found)?;
    let original = view.find(&id).ok_or_else(ApiError::not_found)?;
    if !server
        .db
        .bitwarden_share_cipher(
            &user.id,
            &shared,
            original.revision_at,
            &collections,
            server.config.storage_quota_bytes,
        )
        .await?
    {
        return Err(ApiError::bad_request(OUT_OF_DATE));
    }
    touch(&server, &user.id).await?;
    touch_org(&server, org).await?;
    Ok(Json(render_one(&server, &user.id, &id).await?))
}

/// `PUT /ciphers/share`: `{ciphers, collectionIds}`, each with its `id`.
pub(super) async fn share_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut body = normalize(body);
    let collections = collection_ids(&body);
    let ciphers = match body.remove("ciphers") {
        Some(Value::Array(items)) if items.len() <= SHARE_LIMIT => items,
        _ => {
            return Err(ApiError::bad_request(
                "Share between 1 and 500 items at once.",
            ))
        }
    };
    let view = VaultView::load(&server, &user.id).await?;
    let (mut ids, mut orgs, mut prepared) = (Vec::new(), HashSet::new(), Vec::new());
    for cipher in ciphers {
        let id = normalize(cipher.clone())
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(ApiError::not_found)?;
        let shared = prepare_share(&user, &view, &id, cipher, &collections)?;
        let original = view.find(&id).ok_or_else(ApiError::not_found)?;
        orgs.extend(shared.organization_id.iter().cloned());
        prepared.push((shared, original.revision_at));
        ids.push(id);
    }
    if !server
        .db
        .bitwarden_share_ciphers(
            &user.id,
            &prepared,
            &collections,
            server.config.storage_quota_bytes,
        )
        .await?
    {
        return Err(ApiError::bad_request(OUT_OF_DATE));
    }
    touch(&server, &user.id).await?;
    for org in &orgs {
        touch_org(&server, org).await?;
    }
    let view = VaultView::load(&server, &user.id).await?;
    let shared: Vec<Value> = ids
        .iter()
        .filter_map(|id| view.find(id))
        .map(|c| view.render(c))
        .collect();
    Ok(Json(list_json(&shared)))
}
