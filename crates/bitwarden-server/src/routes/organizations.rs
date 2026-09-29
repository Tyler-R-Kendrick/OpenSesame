//! `/api/organizations/{id}`: an organization itself — creating one, reading
//! and changing it, deleting and leaving it, and its key pair (ADR 0148 §5).
//!
//! The organization key never reaches the server in the clear: its creator
//! sends it wrapped under their own public key, and the organization's RSA
//! private key wrapped under it. Its name is the one thing about it the
//! server reads, as Bitwarden's does.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use opensesame_storage::bitwarden::{
    member_status, member_type, BitwardenCollection, BitwardenOrgMember, BitwardenOrganization,
};
use serde_json::{json, Map, Value};

use super::accounts::prove_password;
use super::credentials::text;
use super::folders::list_json;
use super::vault_view::{managing, membership};
use super::{touch, touch_org};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize};
use crate::wire::org::{organization_json, organization_keys, profile_organization};
use crate::BitwardenServer;

/// Longest organization name or billing address accepted.
const NAME_LIMIT: usize = 256;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route("/organizations", post(create))
        .route(
            "/organizations/{org}",
            get(read).put(update).post(update).delete(remove),
        )
        .route("/organizations/{org}/delete", post(remove))
        .route("/organizations/{org}/leave", post(leave))
        .route("/organizations/{org}/keys", get(keys).post(set_keys))
        .route("/organizations/{org}/public-key", get(public_key))
        .route("/organizations/{org}/groups", get(empty_list))
        .route("/organizations/{org}/auto-enroll-status", get(auto_enroll))
}

/// The account's confirmed memberships, as its profile lists them.
pub(crate) async fn for_profile(server: &BitwardenServer, user_id: &str) -> ApiResult<Vec<Value>> {
    Ok(server
        .db
        .bitwarden_memberships(user_id)
        .await?
        .iter()
        .filter(|(member, _)| member.status == member_status::CONFIRMED)
        .map(|(member, org)| profile_organization(member, org))
        .collect())
}

fn plain_text(body: &Map<String, Value>, key: &str, what: &str) -> ApiResult<String> {
    text(body, key)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty() && v.len() <= NAME_LIMIT)
        .ok_or_else(|| ApiError::bad_request(format!("The {what} is required.")))
}

/// `{publicKey, encryptedPrivateKey}`: a plain public key and a private key
/// wrapped under the organization key.
fn key_pair(body: &Map<String, Value>) -> ApiResult<(Option<String>, Option<String>)> {
    let Some(keys) = body.get("keys").filter(|k| !k.is_null()) else {
        return Ok((None, None));
    };
    let keys = normalize(keys.clone());
    let public = text(&keys, "publicKey").filter(|k| !k.is_empty());
    let private = text(&keys, "encryptedPrivateKey").filter(|k| is_enc_string(k));
    match (public, private) {
        (Some(public), Some(private)) => Ok((Some(public), Some(private))),
        _ => Err(ApiError::bad_request(
            "The organization's private key must be encrypted.",
        )),
    }
}

/// `POST /organizations`: a new organization, its creator its owner.
async fn create(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    super::policy_rules::may_create_org(&server, &user.id).await?;
    let body = normalize(body);
    let name = plain_text(&body, "name", "organization name")?;
    let billing_email = plain_text(&body, "billingEmail", "billing email")?;
    let key = text(&body, "key")
        .filter(|k| is_enc_string(k))
        .ok_or_else(|| ApiError::bad_request("The organization key must be encrypted."))?;
    let collection_name = text(&body, "collectionName").filter(|n| !n.is_empty());
    if collection_name
        .as_deref()
        .is_some_and(|n| !is_enc_string(n))
    {
        return Err(ApiError::bad_request(
            "The collection name must be encrypted.",
        ));
    }
    let (public_key, private_key) = key_pair(&body)?;
    let now = Utc::now();
    let org = BitwardenOrganization {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        billing_email,
        plan_type: body.get("planType").and_then(Value::as_i64).unwrap_or(0),
        seats: None,
        public_key,
        private_key,
        created_at: now,
        revision_at: now,
    };
    let owner = BitwardenOrgMember {
        id: uuid::Uuid::new_v4().to_string(),
        org_id: org.id.clone(),
        user_id: Some(user.id.clone()),
        email: user.email.clone(),
        key: Some(key),
        status: member_status::CONFIRMED,
        member_type: member_type::OWNER,
        access_all: true,
        permissions: None,
        reset_password_key: None,
        external_id: None,
        created_at: now,
        revision_at: now,
    };
    let collection = collection_name.map(|name| BitwardenCollection {
        id: uuid::Uuid::new_v4().to_string(),
        org_id: org.id.clone(),
        name,
        external_id: None,
        created_at: now,
        revision_at: now,
    });
    server
        .db
        .bitwarden_create_organization(&org, &owner, collection.as_ref())
        .await?;
    touch(&server, &user.id).await?;
    Ok(Json(organization_json(&org)))
}

/// `GET /organizations/{id}`: for those who manage it.
async fn read(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    let view = managing(&server, &user.id, &org, "manageUsers").await?;
    Ok(Json(organization_json(&view.org)))
}

/// `PUT /organizations/{id}`: its name and billing address, by its owner.
async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    if !view.is_owner() {
        return Err(ApiError::not_found());
    }
    let body = normalize(body);
    let mut org = view.org;
    org.name = plain_text(&body, "name", "organization name")?;
    if text(&body, "billingEmail").is_some() {
        org.billing_email = plain_text(&body, "billingEmail", "billing email")?;
    }
    (org.public_key, org.private_key) = key_pair(&body)?;
    org.revision_at = Utc::now();
    server.db.bitwarden_update_organization(&org).await?;
    touch_org(&server, &org.id).await?;
    let org = server
        .db
        .bitwarden_organization(&org.id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(Json(organization_json(&org)))
}

/// `DELETE /organizations/{id}`: with every collection and cipher, by its
/// owner, after the master password.
async fn remove(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let view = membership(&server, &user.id, &org).await?;
    if !view.is_owner() {
        return Err(ApiError::not_found());
    }
    prove_password(&server, &user, &normalize(body)).await?;
    touch_org(&server, &org).await?;
    server.db.bitwarden_delete_organization(&org).await?;
    Ok(StatusCode::OK)
}

/// `POST /organizations/{id}/leave`: any member but the last owner.
async fn leave(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<StatusCode> {
    let members = server.db.bitwarden_org_members(&org).await?;
    let me = members
        .iter()
        .find(|m| m.user_id.as_deref() == Some(user.id.as_str()))
        .ok_or_else(ApiError::not_found)?;
    if last_owner(&members, &me.id) {
        return Err(ApiError::bad_request("The last owner can't leave."));
    }
    server.db.bitwarden_remove_member(&org, &me.id).await?;
    touch(&server, &user.id).await?;
    touch_org(&server, &org).await?;
    Ok(StatusCode::OK)
}

/// Whether `member_id` is the organization's only confirmed owner.
pub(crate) fn last_owner(members: &[BitwardenOrgMember], member_id: &str) -> bool {
    let owners: Vec<&BitwardenOrgMember> = members
        .iter()
        .filter(|m| m.member_type == member_type::OWNER && m.status == member_status::CONFIRMED)
        .collect();
    owners.len() == 1 && owners[0].id == member_id
}

/// `GET /organizations/{id}/keys`: for any confirmed member.
async fn keys(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    Ok(Json(organization_keys(&view.org)))
}

/// `POST /organizations/{id}/keys`: set a key pair on an organization that
/// has none, by whoever manages it.
async fn set_keys(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let view = managing(&server, &user.id, &org, "").await?;
    let mut body = normalize(body);
    let pair = Value::Object(std::mem::take(&mut body));
    body.insert("keys".to_owned(), pair);
    let mut org = view.org;
    if org.public_key.is_some() && org.private_key.is_some() {
        return Err(ApiError::bad_request("Organization keys already exist."));
    }
    (org.public_key, org.private_key) = key_pair(&body)?;
    org.revision_at = Utc::now();
    server.db.bitwarden_update_organization(&org).await?;
    touch_org(&server, &org.id).await?;
    Ok(Json(organization_keys(&org)))
}

/// `GET /organizations/{id}/public-key`.
async fn public_key(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    let view = membership(&server, &user.id, &org).await?;
    Ok(Json(json!({
        "publicKey": view.org.public_key,
        "object": "organizationPublicKey",
    })))
}

/// Policies and groups: this server enforces none and has none.
async fn empty_list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    membership(&server, &user.id, &org).await?;
    Ok(Json(list_json(&[])))
}

/// `GET /organizations/{id}/auto-enroll-status`: account recovery is not
/// offered, so nobody is enrolled automatically.
async fn auto_enroll(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    membership(&server, &user.id, &org).await?;
    Ok(Json(json!({
        "id": org,
        "resetPasswordEnabled": false,
        "object": "organizationAutoEnrollStatus",
    })))
}
