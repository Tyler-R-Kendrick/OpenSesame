//! `/api/organizations/{id}/users`: an organization's members — listing
//! them and changing their role and collections (ADR 0148 §5). Joining is
//! `org_joining`; revoking, restoring and removing, `org_member_status`.

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use opensesame_storage::bitwarden::{member_type, BitwardenCollectionAccess, BitwardenOrgMember};
use serde_json::{json, Map, Value};

use super::credentials::text;
use super::folders::list_json;
use super::organizations::last_owner;
use super::vault_view::{managing, OrgView};
use super::{org_joining, org_member_status, touch};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::normalize;
use crate::wire::org::{member_details, permissions_from, selection};
use crate::BitwardenServer;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route(
            "/organizations/{org}/users",
            get(list).delete(org_member_status::remove_many),
        )
        .route(
            "/organizations/{org}/users/invite",
            post(org_joining::invite),
        )
        .route(
            "/organizations/{org}/users/confirm",
            post(org_joining::confirm_many),
        )
        .route(
            "/organizations/{org}/users/public-keys",
            post(org_joining::public_keys),
        )
        .route(
            "/organizations/{org}/users/reinvite",
            post(org_joining::reinvite_many),
        )
        .route(
            "/organizations/{org}/users/remove",
            post(org_member_status::remove_many),
        )
        .route(
            "/organizations/{org}/users/revoke",
            put(org_member_status::revoke_many),
        )
        .route(
            "/organizations/{org}/users/restore",
            put(org_member_status::restore_many),
        )
        .route(
            "/organizations/{org}/users/{member}",
            get(get_one)
                .put(update)
                .post(update)
                .delete(org_member_status::remove_one),
        )
        .route(
            "/organizations/{org}/users/{member}/delete",
            post(org_member_status::remove_one),
        )
        .route(
            "/organizations/{org}/users/{member}/remove",
            post(org_member_status::remove_one),
        )
        .route(
            "/organizations/{org}/users/{member}/reinvite",
            post(org_joining::reinvite),
        )
        .route(
            "/organizations/{org}/users/{member}/accept",
            post(org_joining::accept),
        )
        .route(
            "/organizations/{org}/users/{member}/confirm",
            post(org_joining::confirm),
        )
        .route(
            "/organizations/{org}/users/{member}/revoke",
            put(org_member_status::revoke),
        )
        .route(
            "/organizations/{org}/users/{member}/restore",
            put(org_member_status::restore),
        )
}

pub(super) async fn members_view(
    server: &BitwardenServer,
    user_id: &str,
    org: &str,
) -> ApiResult<OrgView> {
    managing(server, user_id, org, "manageUsers").await
}

/// Whether the acting member may give a member this role.
pub(super) fn may_assign(actor: &OrgView, role: i64) -> bool {
    match actor.member.member_type {
        member_type::OWNER => true,
        member_type::ADMIN => role != member_type::OWNER,
        _ => role == member_type::USER,
    }
}

/// Whether the acting member may change or remove this member.
pub(super) fn may_act_on(actor: &OrgView, target: &BitwardenOrgMember) -> bool {
    may_assign(actor, target.member_type)
}

pub(super) async fn find(
    server: &BitwardenServer,
    org: &str,
    member: &str,
) -> ApiResult<BitwardenOrgMember> {
    server
        .db
        .bitwarden_org_members(org)
        .await?
        .into_iter()
        .find(|m| m.id == member)
        .ok_or_else(ApiError::not_found)
}

async fn details(
    server: &BitwardenServer,
    member: &BitwardenOrgMember,
    access: &[BitwardenCollectionAccess],
) -> ApiResult<Value> {
    let user = match &member.user_id {
        Some(id) => server.db.bitwarden_user_by_id(id).await?,
        None => None,
    };
    let two_factor = match &member.user_id {
        Some(id) => super::two_factor::enabled(server, id).await?,
        None => false,
    };
    let collections: Vec<Value> = access
        .iter()
        .filter(|a| a.member_id == member.id)
        .map(|a| selection(&a.collection_id, a))
        .collect();
    Ok(member_details(
        member,
        user.as_ref(),
        two_factor,
        &collections,
    ))
}

/// `GET /organizations/{id}/users`.
async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    members_view(&server, &user.id, &org).await?;
    let access = server.db.bitwarden_collection_access(&org).await?;
    let mut out = Vec::new();
    for member in server.db.bitwarden_org_members(&org).await? {
        out.push(details(&server, &member, &access).await?);
    }
    Ok(Json(list_json(&out)))
}

/// `GET /organizations/{id}/users/{member}`.
async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    members_view(&server, &user.id, &org).await?;
    let member = find(&server, &org, &member).await?;
    let access = server.db.bitwarden_collection_access(&org).await?;
    let mut out = details(&server, &member, &access).await?;
    out["object"] = json!("organizationUserDetails");
    Ok(Json(out))
}

/// `[{id, readOnly, hidePasswords, manage}]` for one member, each naming a
/// collection of the organization.
pub(super) fn collection_access(
    view: &OrgView,
    member_id: &str,
    body: &Map<String, Value>,
) -> ApiResult<Vec<BitwardenCollectionAccess>> {
    let known: HashSet<&str> = view.collections.iter().map(|c| c.id.as_str()).collect();
    let flag = |item: &Map<String, Value>, key: &str| {
        item.get(key).and_then(Value::as_bool).unwrap_or(false)
    };
    let mut out = Vec::new();
    for item in body
        .get("collections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let item = normalize(item.clone());
        let id = text(&item, "id").unwrap_or_default();
        if !known.contains(id.as_str()) {
            return Err(ApiError::bad_request(
                "A collection does not belong to this organization.",
            ));
        }
        // A custom role that manages users hands out only what it reaches.
        if !view.manages() && view.collection_rights(&id).is_none() {
            return Err(ApiError::bad_request(
                "You may not grant access to that collection.",
            ));
        }
        out.push(BitwardenCollectionAccess {
            collection_id: id,
            member_id: member_id.to_owned(),
            read_only: flag(&item, "readOnly"),
            hide_passwords: flag(&item, "hidePasswords"),
            manage: flag(&item, "manage"),
        });
    }
    Ok(out)
}

pub(super) fn role(body: &Map<String, Value>) -> ApiResult<i64> {
    match body.get("type").and_then(Value::as_i64) {
        Some(t @ member_type::OWNER..=member_type::CUSTOM) => Ok(t),
        _ => Err(ApiError::bad_request("Unknown member type.")),
    }
}

pub(super) fn bulk_result(id: &str, error: &str) -> Value {
    json!({ "id": id, "error": error, "object": "OrganizationBulkConfirmResponseModel" })
}

pub(super) fn ids(body: &Map<String, Value>) -> Vec<String> {
    body.get("ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `PUT /organizations/{id}/users/{member}`: role, permissions, collections.
async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let view = members_view(&server, &user.id, &org).await?;
    let body = normalize(body);
    let members = server.db.bitwarden_org_members(&org).await?;
    let mut target = members
        .iter()
        .find(|m| m.id == member)
        .cloned()
        .ok_or_else(ApiError::not_found)?;
    let role = role(&body)?;
    if !may_act_on(&view, &target) || !may_assign(&view, role) {
        return Err(ApiError::bad_request("You may not grant that role."));
    }
    if role != member_type::OWNER && last_owner(&members, &target.id) {
        return Err(ApiError::bad_request(
            "Organization must have at least one confirmed owner.",
        ));
    }
    target.member_type = role;
    // Only owners and admins give a member every collection.
    if view.manages() {
        target.access_all = body
            .get("accessAll")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    target.permissions = permissions_from(body.get("permissions"));
    let access = collection_access(&view, &target.id, &body)?;
    server.db.bitwarden_update_member(&target).await?;
    server
        .db
        .bitwarden_set_member_collections(&org, &target.id, &access)
        .await?;
    if let Some(id) = &target.user_id {
        touch(&server, id).await?;
    }
    Ok(StatusCode::OK)
}
