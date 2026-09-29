//! The policies the server itself enforces (ADR 0148 §9), on members who
//! are neither owners nor admins. See `policies` for which and why.

use opensesame_storage::bitwarden::{member_status, member_type, BitwardenOrgMember};
use serde_json::Value;

use super::policies::{
    binding, DISABLE_SEND, PERSONAL_OWNERSHIP, SEND_OPTIONS, SINGLE_ORG, TWO_FACTOR,
};
use super::touch;
use crate::error::{ApiError, ApiResult};
use crate::BitwardenServer;

fn bound(member: &BitwardenOrgMember) -> bool {
    matches!(
        member.status,
        member_status::ACCEPTED | member_status::CONFIRMED
    ) && !matches!(member.member_type, member_type::OWNER | member_type::ADMIN)
}

async fn revoke(server: &BitwardenServer, member: &BitwardenOrgMember) -> ApiResult<()> {
    let mut revoked = member.clone();
    revoked.status = member_status::REVOKED;
    server.db.bitwarden_update_member(&revoked).await?;
    if let Some(user_id) = &member.user_id {
        touch(server, user_id).await?;
    }
    Ok(())
}

async fn has_two_factor(server: &BitwardenServer, user_id: &str) -> ApiResult<bool> {
    super::two_factor::enabled(server, user_id).await
}

/// Whether the account has accepted or joined an organization besides `org`.
async fn elsewhere(server: &BitwardenServer, user_id: &str, org: &str) -> ApiResult<bool> {
    Ok(server
        .db
        .bitwarden_memberships(user_id)
        .await?
        .iter()
        .any(|(m, o)| {
            o.id != org && matches!(m.status, member_status::ACCEPTED | member_status::CONFIRMED)
        }))
}

async fn org_has(server: &BitwardenServer, org: &str, kind: i64) -> ApiResult<bool> {
    Ok(server
        .db
        .bitwarden_policies(org)
        .await?
        .iter()
        .any(|p| p.enabled && p.policy_type == kind))
}

/// A policy was just enabled: revoke the members it now excludes.
pub(crate) async fn enforce_on_enable(
    server: &BitwardenServer,
    org: &str,
    kind: i64,
) -> ApiResult<()> {
    if kind != TWO_FACTOR && kind != SINGLE_ORG {
        return Ok(());
    }
    for member in server.db.bitwarden_org_members(org).await? {
        let Some(user_id) = member.user_id.as_deref().filter(|_| bound(&member)) else {
            continue;
        };
        let excluded = if kind == TWO_FACTOR {
            !has_two_factor(server, user_id).await?
        } else {
            elsewhere(server, user_id, org).await?
        };
        if excluded {
            revoke(server, &member).await?;
        }
    }
    Ok(())
}

/// The account turned its two-step login off: leave every organization
/// that requires it.
pub(crate) async fn after_two_factor_off(server: &BitwardenServer, user_id: &str) -> ApiResult<()> {
    if has_two_factor(server, user_id).await? {
        return Ok(());
    }
    for (member, org) in server.db.bitwarden_memberships(user_id).await? {
        if bound(&member) && org_has(server, &org.id, TWO_FACTOR).await? {
            revoke(server, &member).await?;
        }
    }
    Ok(())
}

/// A member about to be confirmed meets the organization's policies and
/// every single-organization policy binding them elsewhere.
pub(crate) async fn may_confirm(
    server: &BitwardenServer,
    org: &str,
    member: &BitwardenOrgMember,
) -> ApiResult<()> {
    let Some(user_id) = member.user_id.as_deref() else {
        return Ok(());
    };
    if matches!(member.member_type, member_type::OWNER | member_type::ADMIN) {
        return Ok(());
    }
    if org_has(server, org, TWO_FACTOR).await? && !has_two_factor(server, user_id).await? {
        return Err(ApiError::bad_request(
            "This organization requires two-step login, which the user has not turned on.",
        ));
    }
    let refused_here =
        org_has(server, org, SINGLE_ORG).await? && elsewhere(server, user_id, org).await?;
    let bound_elsewhere = binding(server, user_id, SINGLE_ORG)
        .await?
        .iter()
        .any(|(other, _)| other != org);
    if refused_here || bound_elsewhere {
        return Err(ApiError::bad_request(
            "A single organization policy keeps this user out of more than one organization.",
        ));
    }
    Ok(())
}

/// A single-organization policy binding the account keeps it from making
/// another.
pub(crate) async fn may_create_org(server: &BitwardenServer, user_id: &str) -> ApiResult<()> {
    if binding(server, user_id, SINGLE_ORG).await?.is_empty() {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "You may not create an organization. You belong to an organization which has a \
             policy that prohibits you from being a member of any other organization.",
        ))
    }
}

/// Personal ownership keeps new items out of the personal vault.
pub(crate) async fn may_own_items(server: &BitwardenServer, user_id: &str) -> ApiResult<()> {
    if binding(server, user_id, PERSONAL_OWNERSHIP)
        .await?
        .is_empty()
    {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "Due to an Enterprise Policy, you are restricted from saving items to your personal \
             vault. Change the ownership option to an organization and choose from available \
             collections.",
        ))
    }
}

/// Disable Send stops new and changed Sends; Send options can forbid
/// hiding the address.
pub(crate) async fn may_send(
    server: &BitwardenServer,
    user_id: &str,
    hide_email: bool,
) -> ApiResult<()> {
    if !binding(server, user_id, DISABLE_SEND).await?.is_empty() {
        return Err(ApiError::bad_request(
            "Due to an Enterprise Policy, you are only able to delete an existing Send.",
        ));
    }
    let forbids_hiding = binding(server, user_id, SEND_OPTIONS)
        .await?
        .iter()
        .any(|(_, data)| data.get("disableHideEmail").and_then(Value::as_bool) == Some(true));
    if hide_email && forbids_hiding {
        return Err(ApiError::bad_request(
            "Due to an Enterprise Policy, you are not allowed to hide your email address from \
             recipients when creating or editing a Send.",
        ));
    }
    Ok(())
}
