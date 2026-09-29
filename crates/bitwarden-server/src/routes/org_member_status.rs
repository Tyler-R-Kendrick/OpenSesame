//! Revoking, restoring and removing an organization's members (ADR 0148
//! §5), one at a time or in bulk. Nobody acts on themselves this way, an
//! admin never acts on an owner, and the last confirmed owner stays.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use opensesame_storage::bitwarden::member_status;
use serde_json::Value;

use super::folders::list_json;
use super::org_members::{bulk_result, ids, may_act_on, members_view};
use super::organizations::last_owner;
use super::touch;
use super::vault_view::OrgView;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::normalize;
use crate::BitwardenServer;

/// Remove, revoke or restore one member the actor may act on.
async fn act(server: &BitwardenServer, view: &OrgView, member: &str, verb: Verb) -> ApiResult<()> {
    let members = server.db.bitwarden_org_members(&view.org.id).await?;
    let mut target = members
        .iter()
        .find(|m| m.id == member)
        .cloned()
        .ok_or_else(ApiError::not_found)?;
    if !may_act_on(view, &target) || target.id == view.member.id {
        return Err(ApiError::bad_request("You may not change this member."));
    }
    if verb != Verb::Restore && last_owner(&members, &target.id) {
        return Err(ApiError::bad_request(
            "Organization must have at least one confirmed owner.",
        ));
    }
    match verb {
        Verb::Remove => {
            server
                .db
                .bitwarden_remove_member(&view.org.id, &target.id)
                .await?;
        }
        Verb::Revoke => {
            target.status = member_status::REVOKED;
            server.db.bitwarden_update_member(&target).await?;
        }
        Verb::Restore if target.status == member_status::REVOKED => {
            // Back in, a member meets the policies as a confirmed one must.
            super::policy_rules::may_confirm(server, &view.org.id, &target).await?;
            target.status = match (&target.key, &target.user_id) {
                (Some(_), _) => member_status::CONFIRMED,
                (None, Some(_)) => member_status::ACCEPTED,
                (None, None) => member_status::INVITED,
            };
            server.db.bitwarden_update_member(&target).await?;
        }
        Verb::Restore => {}
    }
    if let Some(id) = &target.user_id {
        touch(server, id).await?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verb {
    Remove,
    Revoke,
    Restore,
}

async fn act_one(
    server: BitwardenServer,
    user_id: &str,
    org: &str,
    member: &str,
    verb: Verb,
) -> ApiResult<StatusCode> {
    let view = members_view(&server, user_id, org).await?;
    act(&server, &view, member, verb).await?;
    Ok(StatusCode::OK)
}

async fn act_many(
    server: BitwardenServer,
    user_id: &str,
    org: &str,
    body: Value,
    verb: Verb,
) -> ApiResult<Json<Value>> {
    let view = members_view(&server, user_id, org).await?;
    let mut results = Vec::new();
    for id in ids(&normalize(body)) {
        let error = match act(&server, &view, &id, verb).await {
            Ok(()) => String::new(),
            Err(e) => e.message().to_owned(),
        };
        results.push(bulk_result(&id, &error));
    }
    Ok(Json(list_json(&results)))
}

pub(super) async fn remove_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    act_one(server, &user.id, &org, &member, Verb::Remove).await
}

pub(super) async fn revoke(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    act_one(server, &user.id, &org, &member, Verb::Revoke).await
}

pub(super) async fn restore(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, member)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    act_one(server, &user.id, &org, &member, Verb::Restore).await
}

pub(super) async fn remove_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    act_many(server, &user.id, &org, body, Verb::Remove).await
}

pub(super) async fn revoke_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    act_many(server, &user.id, &org, body, Verb::Revoke).await
}

pub(super) async fn restore_many(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    act_many(server, &user.id, &org, body, Verb::Restore).await
}
