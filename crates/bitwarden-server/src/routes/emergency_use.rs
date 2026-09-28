//! Using approved emergency access (ADR 0148 §6): a contact with *view*
//! access reads the grantor's own ciphers and their files, and one with
//! *takeover* access sets a new master password on the account.
//!
//! Only an approved record serves, only for the kind it grants, and only to
//! its contact. A takeover leaves the grantor's organizations except those
//! they own, drops every session and second step, and keeps the vault: the
//! contact re-wraps the same user key under the new password.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use opensesame_storage::bitwarden::{emergency_status, BitwardenEmergencyAccess, BitwardenUser};
use serde_json::{json, Value};

use super::attachments::attachment_json;
use super::emergency::{as_grantee, takeover_credentials, TAKEOVER, VIEW};
use super::folders::list_json;
use super::vault_view::VaultView;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::normalize;
use crate::BitwardenServer;

/// The approved record of `kind` naming this contact, and its grantor.
async fn approved(
    server: &BitwardenServer,
    user: &BitwardenUser,
    id: &str,
    kind: i64,
) -> ApiResult<(BitwardenEmergencyAccess, BitwardenUser)> {
    let access = as_grantee(server, user, id).await?;
    if access.status != emergency_status::RECOVERY_APPROVED || access.access_type != kind {
        return Err(ApiError::bad_request("Emergency access not valid."));
    }
    let grantor = server
        .db
        .bitwarden_user_by_id(&access.grantor_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok((access, grantor))
}

/// `POST /emergency-access/{id}/view`: the grantor's own ciphers and the
/// key that opens them, wrapped for this contact.
pub async fn view(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (access, grantor) = approved(&server, &user, &id, VIEW).await?;
    let vault = VaultView::load(&server, &grantor.id).await?;
    let ciphers: Vec<Value> = vault
        .ciphers
        .iter()
        .filter(|c| c.user_id.as_deref() == Some(grantor.id.as_str()) && c.deleted_at.is_none())
        .map(|c| vault.render(c))
        .collect();
    Ok(Json(json!({
        "ciphers": ciphers,
        "keyEncrypted": access.key_encrypted,
        "object": "emergencyAccessView",
    })))
}

/// `GET /emergency-access/{id}/{cipher}/attachment/{attachment}`: a file
/// of one of those ciphers, with a fresh link.
pub async fn attachment(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((id, cipher_id, attachment_id)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    let (_, grantor) = approved(&server, &user, &id, VIEW).await?;
    let owned = server
        .db
        .bitwarden_cipher(&grantor.id, &cipher_id)
        .await?
        .is_some_and(|c| c.organization_id.is_none());
    if !owned {
        return Err(ApiError::not_found());
    }
    match server
        .db
        .bitwarden_attachment_of(&cipher_id, &attachment_id)
        .await?
    {
        Some(file) if file.uploaded => Ok(Json(attachment_json(&server, &file)?)),
        _ => Err(ApiError::not_found()),
    }
}

/// `POST /emergency-access/{id}/takeover`: what the contact needs to set a
/// new password — the grantor's KDF, and the user key wrapped for them.
pub async fn takeover(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (access, grantor) = approved(&server, &user, &id, TAKEOVER).await?;
    Ok(Json(json!({
        "kdf": grantor.kdf.kdf_type,
        "kdfIterations": grantor.kdf.iterations,
        "kdfMemory": grantor.kdf.memory,
        "kdfParallelism": grantor.kdf.parallelism,
        "keyEncrypted": access.key_encrypted,
        "object": "emergencyAccessTakeover",
    })))
}

/// `POST /emergency-access/{id}/password`: `{newMasterPasswordHash, key}`,
/// derived under the grantor's address and KDF.
pub async fn password(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let (_, grantor) = approved(&server, &user, &id, TAKEOVER).await?;
    let credentials = takeover_credentials(&server, &grantor, &normalize(body)).await?;
    server
        .db
        .bitwarden_emergency_takeover(&grantor.id, &credentials)
        .await?;
    tracing::info!("bitwarden-compat account taken over by its emergency contact");
    Ok(StatusCode::OK)
}

/// `GET /emergency-access/{id}/policies`: this server enforces none.
pub async fn policies(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    approved(&server, &user, &id, TAKEOVER).await?;
    Ok(Json(list_json(&[])))
}
