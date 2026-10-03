//! The policies the server itself enforces (ADR 0148 §9), on members who
//! are neither owners nor admins. See `policies` for which and why.
//!
//! Who may be a member — two-step login and single organization — is decided
//! in storage, in the transaction that changes the membership
//! (`opensesame_storage::bitwarden::PolicyViolation`); this file words the
//! refusals and holds the checks on what a member may store.

use opensesame_storage::bitwarden::PolicyViolation;
use serde_json::Value;

use super::policies::{binding, DISABLE_SEND, PERSONAL_OWNERSHIP, SEND_OPTIONS};
use crate::error::{ApiError, ApiResult};
use crate::BitwardenServer;

/// The refusal for a policy that keeps an account out of an organization.
pub(crate) fn refusal(violation: PolicyViolation) -> ApiError {
    ApiError::bad_request(match violation {
        PolicyViolation::TwoStepLogin => {
            "This organization requires two-step login, which the user has not turned on."
        }
        PolicyViolation::SingleOrganization => {
            "A single organization policy keeps this user out of more than one organization."
        }
    })
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
