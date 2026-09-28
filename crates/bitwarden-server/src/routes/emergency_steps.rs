//! The steps of emergency access (ADR 0148 §6): accepting an invitation,
//! the grantor's confirmation, and a recovery's initiation, approval or
//! rejection. Each moves a record on only from the status it expects, by a
//! compare-and-set, and wakes both parties' clients.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{emergency_status as status, BitwardenEmergencyAccess};
use serde_json::Value;

use super::credentials::text;
use super::emergency::{as_grantee, as_grantor, base_json, not_valid, settled};
use super::touch;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize};
use crate::BitwardenServer;

/// `POST …/reinvite`: an address that has since registered is accepted.
pub(super) async fn reinvite(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let access = as_grantor(&server, &user, &id).await?;
    if access.status != status::INVITED {
        return Err(ApiError::bad_request("The contact already accepted."));
    }
    if let Some(contact) = server.db.bitwarden_user_by_email(&access.email).await? {
        server
            .db
            .bitwarden_claim_emergency_invitations(&contact.id, &contact.email)
            .await?;
    }
    Ok(StatusCode::OK)
}

/// `POST …/accept`: the invited account itself takes up an invitation.
pub(super) async fn accept(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let access = settled(&server, &id).await?;
    if access.email != user.email {
        return Err(ApiError::bad_request(
            "This invitation is for another address.",
        ));
    }
    if access.status == status::INVITED {
        server
            .db
            .bitwarden_claim_emergency_invitations(&user.id, &user.email)
            .await?;
    }
    Ok(StatusCode::OK)
}

/// `POST …/confirm`: `{key}`, the grantor's user key wrapped under the
/// contact's public key.
pub(super) async fn confirm(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let access = as_grantor(&server, &user, &id).await?;
    let key = text(&normalize(body), "key")
        .filter(|k| is_enc_string(k))
        .ok_or_else(|| ApiError::bad_request("The key must be encrypted."))?;
    if access.status != status::ACCEPTED || access.grantee_id.is_none() {
        return Err(not_valid());
    }
    step(&server, access, status::ACCEPTED, |a| {
        a.status = status::CONFIRMED;
        a.key_encrypted = Some(key);
    })
    .await
}

/// Move a record on with `change`, only while it is still in `from`.
async fn step(
    server: &BitwardenServer,
    access: BitwardenEmergencyAccess,
    from: i64,
    change: impl FnOnce(&mut BitwardenEmergencyAccess),
) -> ApiResult<Json<Value>> {
    let mut next = access;
    change(&mut next);
    next.revision_at = Utc::now();
    if !server
        .db
        .bitwarden_emergency_transition(&next, from)
        .await?
    {
        return Err(not_valid());
    }
    for party in [Some(&next.grantor_id), next.grantee_id.as_ref()]
        .into_iter()
        .flatten()
    {
        touch(server, party).await?;
    }
    Ok(Json(base_json(&next)))
}

/// `POST …/initiate`: the contact starts the wait.
pub(super) async fn initiate(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let access = as_grantee(&server, &user, &id).await?;
    if access.status != status::CONFIRMED {
        return Err(not_valid());
    }
    step(&server, access, status::CONFIRMED, |a| {
        a.status = status::RECOVERY_INITIATED;
        a.recovery_initiated_at = Some(Utc::now());
    })
    .await
}

/// `POST …/approve`: the grantor ends the wait early.
pub(super) async fn approve(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let access = as_grantor(&server, &user, &id).await?;
    if access.status != status::RECOVERY_INITIATED {
        return Err(not_valid());
    }
    step(&server, access, status::RECOVERY_INITIATED, |a| {
        a.status = status::RECOVERY_APPROVED;
    })
    .await
}

/// `POST …/reject`: the grantor refuses, before or after approval.
pub(super) async fn reject(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let access = as_grantor(&server, &user, &id).await?;
    let from = access.status;
    if from != status::RECOVERY_INITIATED && from != status::RECOVERY_APPROVED {
        return Err(not_valid());
    }
    step(&server, access, from, |a| {
        a.status = status::CONFIRMED;
        a.recovery_initiated_at = None;
    })
    .await
}
