//! Organization policies (ADR 0148 §9). Owners, admins and custom roles
//! allowed to manage policies set them; a sync carries the enabled ones of
//! every organization an account is a confirmed member of, and clients
//! enforce most of them from there.
//!
//! The server enforces the ones that guard what it stores, on members who
//! are neither owners nor admins, as Bitwarden's does:
//!
//! * two-step login — enabling it revokes members without it; turning one's
//!   own off revokes one from such organizations; a member without it is not
//!   confirmed;
//! * single organization — enabling it revokes members who belong to
//!   another; such a member is not confirmed into another, nor creates one;
//! * personal ownership — no new personal items;
//! * disable Send, and Send options' "hide my email" — no new or changed
//!   Sends, or none hiding the address.

use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::Utc;
use opensesame_storage::bitwarden::{member_status, member_type, BitwardenPolicy};
use serde_json::{json, Value};

use super::folders::list_json;
use super::vault_view::{managing, membership};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::normalize;
use crate::BitwardenServer;

pub(crate) const PERSONAL_OWNERSHIP: i64 = 5;
pub(crate) const DISABLE_SEND: i64 = 6;
pub(crate) const SEND_OPTIONS: i64 = 7;
/// The policy types Bitwarden's clients know today.
const KNOWN: std::ops::RangeInclusive<i64> = 0..=20;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route("/organizations/{org}/policies", get(list))
        .route(
            "/organizations/{org}/policies/{kind}",
            get(get_one).put(set),
        )
        .route("/organizations/{org}/policies/{kind}/vnext", put(set))
        .route("/plans", get(plans))
}

fn policy_json(policy: &BitwardenPolicy) -> Value {
    json!({
        "id": policy.id,
        "organizationId": policy.org_id,
        "type": policy.policy_type,
        "data": policy.data.as_deref().and_then(|d| serde_json::from_str::<Value>(d).ok()),
        "enabled": policy.enabled,
        "revisionDate": crate::wire::account::date(policy.revision_at),
        "object": "policy",
    })
}

fn unset(org: &str, kind: i64) -> BitwardenPolicy {
    BitwardenPolicy {
        id: uuid::Uuid::new_v4().to_string(),
        org_id: org.to_owned(),
        policy_type: kind,
        enabled: false,
        data: None,
        revision_at: Utc::now(),
    }
}

/// `GET /organizations/{id}/policies`: for any confirmed member.
async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(org): Path<String>,
) -> ApiResult<Json<Value>> {
    membership(&server, &user.id, &org).await?;
    let out: Vec<Value> = server
        .db
        .bitwarden_policies(&org)
        .await?
        .iter()
        .map(policy_json)
        .collect();
    Ok(Json(list_json(&out)))
}

/// `GET /organizations/{id}/policies/{type}`.
async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, kind)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    managing(&server, &user.id, &org, "managePolicies").await?;
    let policy = server
        .db
        .bitwarden_policies(&org)
        .await?
        .into_iter()
        .find(|p| p.policy_type == kind)
        .unwrap_or_else(|| unset(&org, kind));
    Ok(Json(policy_json(&policy)))
}

/// `PUT /organizations/{id}/policies/{type}`: `{enabled, data}`, or
/// `{policy: {enabled, data}}` as current clients send it.
async fn set(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((org, kind)): Path<(String, i64)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    managing(&server, &user.id, &org, "managePolicies").await?;
    if !KNOWN.contains(&kind) {
        return Err(ApiError::bad_request("Invalid or unsupported policy type."));
    }
    let mut body = normalize(body);
    if let Some(Value::Object(inner)) = body.remove("policy") {
        body = normalize(Value::Object(inner));
    }
    let enabled = body
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let data = body
        .get("data")
        .filter(|d| !d.is_null())
        .map(Value::to_string);
    if data.as_ref().is_some_and(|d| d.len() > 16 * 1024) {
        return Err(ApiError::bad_request(
            "The policy's settings are too large.",
        ));
    }
    let current = server
        .db
        .bitwarden_policies(&org)
        .await?
        .into_iter()
        .find(|p| p.policy_type == kind);
    let policy = BitwardenPolicy {
        enabled,
        data,
        revision_at: Utc::now(),
        ..current.unwrap_or_else(|| unset(&org, kind))
    };
    // Set, and the members it excludes revoked, in one transaction.
    let revoked = server.db.bitwarden_put_policy_enforcing(&policy).await?;
    for user_id in &revoked {
        super::touch(&server, user_id).await?;
    }
    super::touch_org(&server, &org).await?;
    Ok(Json(policy_json(&policy)))
}

/// The enabled policies a sync carries: every organization the account is
/// a confirmed member of.
pub(crate) async fn for_sync(server: &BitwardenServer, user_id: &str) -> ApiResult<Vec<Value>> {
    let mut out = Vec::new();
    for (member, org) in server.db.bitwarden_memberships(user_id).await? {
        if member.status != member_status::CONFIRMED {
            continue;
        }
        for policy in server.db.bitwarden_policies(&org.id).await? {
            if policy.enabled {
                out.push(policy_json(&policy));
            }
        }
    }
    Ok(out)
}

/// The settings of every enabled policy of `kind` that binds the account:
/// in an organization it has accepted or joined, as neither owner nor admin.
pub(crate) async fn binding(
    server: &BitwardenServer,
    user_id: &str,
    kind: i64,
) -> ApiResult<Vec<(String, Value)>> {
    let mut out = Vec::new();
    for (member, org) in server.db.bitwarden_memberships(user_id).await? {
        let bound = matches!(
            member.status,
            member_status::ACCEPTED | member_status::CONFIRMED
        ) && !matches!(member.member_type, member_type::OWNER | member_type::ADMIN);
        if !bound {
            continue;
        }
        for policy in server.db.bitwarden_policies(&org.id).await? {
            if policy.enabled && policy.policy_type == kind {
                let data = policy
                    .data
                    .as_deref()
                    .and_then(|d| serde_json::from_str(d).ok())
                    .unwrap_or(Value::Null);
                out.push((org.id.clone(), data));
            }
        }
    }
    Ok(out)
}

/// `GET /plans`: the one plan this server has, so the web vault can create
/// an organization.
async fn plans() -> Json<Value> {
    Json(json!({
        "object": "list",
        "data": [{
            "object": "plan",
            "type": 0,
            "product": 0,
            "name": "Free",
            "nameLocalizationKey": "planNameFree",
            "descriptionLocalizationKey": "planDescFree",
            "bitwardenProduct": 0,
            "maxUsers": 0,
        }],
        "continuationToken": null,
    }))
}
