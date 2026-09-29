//! Joining an organization (ADR 0148 §5): invitation, acceptance and
//! confirmation.
//!
//! This server sends no mail, so an invitation cannot carry a token: an
//! address that already has an account is accepted at once, and one that
//! has none waits and is claimed when that address registers. Either way a
//! member holds nothing until an administrator *confirms* them, wrapping the
//! organization key under the member's public key on the administrator's own
//! device — the step where Bitwarden shows the member's fingerprint phrase.

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{member_status, BitwardenOrgMember};
use serde_json::{json, Value};

use super::credentials::text;
use super::folders::list_json;
use super::identity::normalize_email;
use super::org_members::{
    bulk_result, collection_access, find, ids, may_assign, members_view, role,
};
use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize};
use crate::wire::org::permissions_from;
use crate::BitwardenServer;

/// Bitwarden invites at most this many addresses at once.
const INVITE_LIMIT: usize = 20;

/// `POST /organizations/{id}/users/invite`: `{emails, type, permissions,
/// collections}`.
pub(super) async fn invite(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let view = members_view(&server, &user.id, &org).await?;
    let body = normalize(body);
    let role = role(&body)?;
    if !may_assign(&view, role) {
        return Err(ApiError::bad_request("You may not grant that role."));
    }
    let emails: Vec<String> = body
        .get("emails")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(normalize_email)
                .collect()
        })
        .unwrap_or_default();
    if emails.is_empty() || emails.len() > INVITE_LIMIT {
        return Err(ApiError::bad_request(format!(
            "Invite between 1 and {INVITE_LIMIT} addresses at once."
        )));
    }
    let now = Utc::now();
    let mut members = Vec::new();
    for email in emails.into_iter().filter(|e| e.contains('@')) {
        let account = server.db.bitwarden_user_by_email(&email).await?;
        members.push(BitwardenOrgMember {
            id: uuid::Uuid::new_v4().to_string(),
            org_id: org.clone(),
            status: if account.is_some() {
                member_status::ACCEPTED
            } else {
                member_status::INVITED
            },
            user_id: account.map(|a| a.id),
            email,
            key: None,
            member_type: role,
            access_all: false,
            permissions: permissions_from(body.get("permissions")),
            reset_password_key: None,
            external_id: None,
            created_at: now,
            revision_at: now,
        });
    }
    let added = server.db.bitwarden_add_members(&members).await?;
    for member in members.iter().filter(|m| added.contains(&m.id)) {
        let access = collection_access(&view, &member.id, &body)?;
        server
            .db
            .bitwarden_set_member_collections(&org, &member.id, &access)
            .await?;
        if let Some(id) = &member.user_id {
            touch(&server, id).await?;
        }
    }
    Ok(StatusCode::OK)
}

/// `POST …/reinvite`: there is no mail to send again.
pub(super) async fn reinvite(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    members_view(&server, &user.id, &org).await?;
    find(&server, &org, &member).await?;
    Ok(StatusCode::OK)
}

pub(super) async fn reinvite_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    members_view(&server, &user.id, &org).await?;
    let results: Vec<Value> = ids(&normalize(body))
        .iter()
        .map(|id| bulk_result(id, ""))
        .collect();
    Ok(Json(list_json(&results)))
}

/// `POST …/accept`: the invited account itself takes up its invitation.
pub(super) async fn accept(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let member = find(&server, &org, &member).await?;
    if member.email != user.email {
        return Err(ApiError::bad_request(
            "This invitation is for another address.",
        ));
    }
    if member.status == member_status::INVITED {
        server
            .db
            .bitwarden_claim_invitations(&user.id, &user.email)
            .await?;
    }
    Ok(StatusCode::OK)
}

/// `POST …/{member}/confirm`: `{key}`, the organization key wrapped under
/// the member's public key.
pub(super) async fn confirm(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    members_view(&server, &user.id, &org).await?;
    let key = text(&normalize(body), "key").unwrap_or_default();
    confirm_one(&server, &org, &member, &key).await?;
    Ok(StatusCode::OK)
}

async fn confirm_one(
    server: &BitwardenServer,
    org: &str,
    member: &str,
    key: &str,
) -> ApiResult<()> {
    if !is_enc_string(key) {
        return Err(ApiError::bad_request(
            "The organization key must be encrypted.",
        ));
    }
    super::policy_rules::may_confirm(server, org, &find(server, org, member).await?).await?;
    if !server.db.bitwarden_confirm_member(org, member, key).await? {
        return Err(ApiError::bad_request("User not valid."));
    }
    if let Some(id) = find(server, org, member).await?.user_id {
        touch(server, &id).await?;
    }
    Ok(())
}

/// `POST …/users/confirm`: `{keys: [{id, key}]}`.
pub(super) async fn confirm_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    members_view(&server, &user.id, &org).await?;
    let body = normalize(body);
    let mut results = Vec::new();
    for item in body
        .get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let item = normalize(item.clone());
        let (id, key) = (
            text(&item, "id").unwrap_or_default(),
            text(&item, "key").unwrap_or_default(),
        );
        let error = match confirm_one(&server, &org, &id, &key).await {
            Ok(()) => String::new(),
            Err(e) => e.message().to_owned(),
        };
        results.push(bulk_result(&id, &error));
    }
    Ok(Json(list_json(&results)))
}

/// `POST …/users/public-keys`: `{ids}`, each member's account public key.
pub(super) async fn public_keys(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    members_view(&server, &user.id, &org).await?;
    let wanted: HashSet<String> = ids(&normalize(body)).into_iter().collect();
    let mut out = Vec::new();
    for member in server.db.bitwarden_org_members(&org).await? {
        let Some(user_id) = member
            .user_id
            .as_deref()
            .filter(|_| wanted.contains(&member.id))
        else {
            continue;
        };
        if let Some(account) = server.db.bitwarden_user_by_id(user_id).await? {
            out.push(json!({
                "id": member.id,
                "userId": user_id,
                "key": account.public_key,
                "object": "organizationUserPublicKeyResponseModel",
            }));
        }
    }
    Ok(Json(list_json(&out)))
}
