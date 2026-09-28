//! `POST /api/ciphers/import-organization?organizationId=` (ADR 0148 §5):
//! `{ciphers, collections, collectionRelationships}`, where each
//! relationship pairs a cipher index (`key`) with a collection index
//! (`value`). A collection with the id of one the organization already has
//! is that one; any other is created. All of it lands or none of it does.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenCollection;
use serde_json::Value;

use super::cipher_bulk::{IMPORT_CIPHERS, IMPORT_FOLDERS};
use super::ciphers::new_cipher;
use super::credentials::text;
use super::org_ciphers::OrgQuery;
use super::touch_org;
use super::vault_view::managing;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize, parse_cipher_for};
use crate::BitwardenServer;

fn invalid() -> ApiError {
    ApiError::bad_request("Invalid collection relationship.")
}

pub async fn import(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Query(query): Query<OrgQuery>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let org = query.organization_id;
    let view = managing(&server, &user.id, &org, "accessImportExport").await?;
    let mut body = normalize(body);
    let count = |key: &str| body.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    if count("ciphers") > IMPORT_CIPHERS
        || count("collectionRelationships") > IMPORT_CIPHERS
        || count("collections") > IMPORT_FOLDERS
    {
        return Err(ApiError::bad_request(format!(
            "You cannot import more than {IMPORT_CIPHERS} items or {IMPORT_FOLDERS} collections at once."
        )));
    }
    let mut array = |key: &str| match body.remove(key) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    let now = Utc::now();
    let (mut targets, mut created) = (Vec::new(), Vec::new());
    for collection in array("collections") {
        let collection = normalize(collection);
        let existing =
            text(&collection, "id").filter(|id| view.collections.iter().any(|c| &c.id == id));
        if let Some(id) = existing {
            targets.push(id);
            continue;
        }
        let name = text(&collection, "name")
            .filter(|n| is_enc_string(n))
            .ok_or_else(|| ApiError::bad_request("The collection name must be encrypted."))?;
        let fresh = BitwardenCollection {
            id: uuid::Uuid::new_v4().to_string(),
            org_id: org.clone(),
            name,
            external_id: text(&collection, "externalId").filter(|e| !e.is_empty()),
            created_at: now,
            revision_at: now,
        };
        targets.push(fresh.id.clone());
        created.push(fresh);
    }
    let ciphers = array("ciphers")
        .into_iter()
        .map(|cipher| {
            let mut input = parse_cipher_for(cipher, &user.id, Some(&org))?;
            input.folder_id = None;
            let mut cipher = new_cipher(&user, input, now);
            cipher.user_id = None;
            cipher.organization_id = Some(org.clone());
            cipher.favorite = false;
            Ok(cipher)
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let mut links = Vec::new();
    for relationship in array("collectionRelationships") {
        let relationship = normalize(relationship);
        let index = |key: &str| {
            relationship
                .get(key)
                .and_then(Value::as_u64)
                .and_then(|i| usize::try_from(i).ok())
        };
        let (Some(cipher), Some(collection)) = (index("key"), index("value")) else {
            return Err(invalid());
        };
        let cipher = ciphers.get(cipher).ok_or_else(invalid)?;
        let collection = targets.get(collection).ok_or_else(invalid)?;
        links.push((cipher.id.clone(), collection.clone()));
    }
    server
        .db
        .bitwarden_import_org(&created, &ciphers, &links)
        .await?;
    touch_org(&server, &org).await?;
    Ok(StatusCode::OK)
}
