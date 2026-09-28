//! Attachments (ADR 0148): files on a cipher, encrypted by the client under a
//! key the server never holds.
//!
//! A client announces a file (`/attachment/v2`: its encrypted name and key,
//! and its size), then uploads the ciphertext to the URL it is given; older
//! clients do both in one multipart request. A download is a URL carrying a
//! short-lived token, so a client can hand it to its file fetcher without its
//! own bearer token.

use axum::body::Bytes;
use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenAttachment, BitwardenCipher};
use serde_json::{json, Value};

use super::credentials::text;
use super::file_links::{download_url, file_id};
use super::vault_view::{render_one, VaultView};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{is_enc_string, normalize};
use crate::wire::files::size_name;
use crate::BitwardenServer;

/// Declared and uploaded sizes may differ by this much (encryption padding).
pub(crate) const SIZE_LEEWAY: i64 = 1024 * 1024;

pub(crate) fn attachment_json(
    server: &BitwardenServer,
    attachment: &BitwardenAttachment,
) -> ApiResult<Value> {
    Ok(json!({
        "id": attachment.id,
        "url": download_url(server, &attachment.cipher_id, &attachment.id)?,
        "fileName": attachment.file_name,
        "key": attachment.key,
        "size": attachment.size.to_string(),
        "sizeName": size_name(attachment.size),
        "object": "attachment",
    }))
}

/// A file of `size` bytes fits the per-file limit and, with the `used`
/// bytes already claimed, the quota.
fn admit(server: &BitwardenServer, used: i64, size: i64) -> ApiResult<()> {
    let limit = i64::try_from(server.config.max_file_bytes).unwrap_or(i64::MAX);
    if size <= 0 || size > limit {
        return Err(ApiError::bad_request(format!(
            "Max file size is {}.",
            size_name(limit)
        )));
    }
    if used.saturating_add(size) > server.config.storage_quota_bytes {
        return Err(ApiError::bad_request("Not enough storage available."));
    }
    Ok(())
}

/// A file of `size` bytes fits the per-file limit and the account's quota.
pub(crate) async fn admit_size(
    server: &BitwardenServer,
    user_id: &str,
    size: i64,
) -> ApiResult<()> {
    admit(
        server,
        server.db.bitwarden_storage_used(user_id).await?,
        size,
    )
}

/// A file for this cipher fits its owner's quota: the account's for a
/// personal cipher, the organization's for one of its ciphers.
async fn admit_for(server: &BitwardenServer, cipher: &BitwardenCipher, size: i64) -> ApiResult<()> {
    match (&cipher.user_id, &cipher.organization_id) {
        (Some(user_id), _) => admit_size(server, user_id, size).await,
        (None, Some(org_id)) => admit(
            server,
            server.db.bitwarden_org_storage_used(org_id).await?,
            size,
        ),
        (None, None) => Err(ApiError::not_found()),
    }
}

/// What a client needs to upload an announced file: where to, and the
/// cipher as it will read once the file lands, the new attachment included.
fn upload_data(
    server: &BitwardenServer,
    view: &VaultView,
    cipher: &BitwardenCipher,
    attachment: &BitwardenAttachment,
) -> ApiResult<Json<Value>> {
    let mut rendered = view.render(cipher);
    let pending = attachment_json(server, attachment)?;
    match rendered.get_mut("attachments") {
        Some(Value::Array(listed)) => listed.push(pending),
        _ => rendered["attachments"] = json!([pending]),
    }
    Ok(Json(json!({
        "attachmentId": attachment.id,
        "url": format!("{}/api/ciphers/{}/attachment/{}", server.config.public_url, cipher.id, attachment.id),
        "fileUploadType": 0,
        "cipherResponse": rendered,
        "cipherMiniResponse": rendered,
        "object": "attachment-fileUpload",
    })))
}

/// A new attachment on `cipher`, counted against the cipher's owner.
fn new_attachment(
    cipher: &BitwardenCipher,
    file_name: String,
    key: String,
    size: i64,
) -> BitwardenAttachment {
    BitwardenAttachment {
        id: file_id(),
        cipher_id: cipher.id.clone(),
        user_id: cipher.user_id.clone(),
        file_name,
        key: Some(key),
        size,
        uploaded: false,
        created_at: Utc::now(),
    }
}

/// `POST /ciphers/{id}/attachment/v2`: announce a file; upload it next.
pub async fn announce(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(cipher_id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.reach_to_edit(&cipher_id)?;
    let file_name = text(&body, "fileName").filter(|n| is_enc_string(n));
    let key = text(&body, "key").filter(|k| is_enc_string(k));
    let (Some(file_name), Some(key)) = (file_name, key) else {
        return Err(ApiError::bad_request(
            "The file name and key must be encrypted.",
        ));
    };
    let size = body.get("fileSize").and_then(Value::as_i64).unwrap_or(0);
    admit_for(&server, cipher, size).await?;
    let attachment = new_attachment(cipher, file_name, key, size);
    server.db.bitwarden_add_attachment(&attachment).await?;
    upload_data(&server, &view, cipher, &attachment)
}

/// `GET /ciphers/{id}/attachment/{attachmentId}/renew`: the upload URL again.
pub async fn renew(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.reach_to_edit(&cipher_id)?;
    match server.db.bitwarden_attachment_of(&cipher.id, &id).await? {
        Some(attachment) if !attachment.uploaded => {
            upload_data(&server, &view, cipher, &attachment)
        }
        _ => Err(ApiError::not_found()),
    }
}

/// The bytes and, when present, the `key` part of a multipart upload.
pub(crate) async fn read_upload(
    mut form: Multipart,
) -> ApiResult<(Bytes, Option<String>, Option<String>)> {
    let (mut data, mut key, mut name) = (None, None, None);
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|_| ApiError::bad_request("Invalid multipart body."))?
    {
        match field.name() {
            Some("data") => {
                name = field.file_name().map(str::to_owned);
                data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| ApiError::bad_request("Upload failed."))?,
                );
            }
            Some("key") => key = field.text().await.ok(),
            _ => {}
        }
    }
    let data = data.ok_or_else(|| ApiError::bad_request("No file was uploaded."))?;
    Ok((data, key, name))
}

async fn store(
    server: &BitwardenServer,
    cipher: &BitwardenCipher,
    attachment: &BitwardenAttachment,
    data: &[u8],
) -> ApiResult<()> {
    let length = i64::try_from(data.len()).unwrap_or(i64::MAX);
    if length == 0 || (length - attachment.size).abs() > SIZE_LEEWAY {
        return Err(ApiError::bad_request("File size does not match."));
    }
    if !server
        .db
        .bitwarden_upload_attachment_of(&cipher.id, &attachment.id, data)
        .await?
    {
        return Err(ApiError::bad_request(
            "This attachment was already uploaded.",
        ));
    }
    server
        .db
        .bitwarden_touch_any_cipher(&cipher.id, Utc::now())
        .await?;
    super::touch_cipher(server, cipher).await?;
    Ok(())
}

/// `POST /ciphers/{id}/attachment/{attachmentId}`: the announced file's bytes.
pub async fn upload(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
    form: Multipart,
) -> ApiResult<StatusCode> {
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.reach_to_edit(&cipher_id)?;
    let attachment = server
        .db
        .bitwarden_attachment_of(&cipher.id, &id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let (data, _, _) = read_upload(form).await?;
    store(&server, cipher, &attachment, &data).await?;
    Ok(StatusCode::OK)
}

/// `POST /ciphers/{id}/attachment`: announce and upload at once, as older
/// clients do; the encrypted file name is the part's file name.
pub async fn upload_legacy(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(cipher_id): Path<String>,
    form: Multipart,
) -> ApiResult<Json<Value>> {
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.reach_to_edit(&cipher_id)?;
    let (data, key, name) = read_upload(form).await?;
    let (Some(file_name), Some(key)) = (
        name.filter(|n| is_enc_string(n)),
        key.filter(|k| is_enc_string(k)),
    ) else {
        return Err(ApiError::bad_request(
            "The file name and key must be encrypted.",
        ));
    };
    let size = i64::try_from(data.len()).unwrap_or(i64::MAX);
    admit_for(&server, cipher, size).await?;
    let attachment = new_attachment(cipher, file_name, key, size);
    server.db.bitwarden_add_attachment(&attachment).await?;
    store(&server, cipher, &attachment, &data).await?;
    Ok(Json(render_one(&server, &user.id, &cipher_id).await?))
}

/// `GET /ciphers/{id}/attachment/{attachmentId}`: metadata and a fresh link.
pub async fn describe(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let view = VaultView::load(&server, &user.id).await?;
    let (cipher, _) = view.reach(&cipher_id)?;
    match server.db.bitwarden_attachment_of(&cipher.id, &id).await? {
        Some(attachment) if attachment.uploaded => Ok(Json(attachment_json(&server, &attachment)?)),
        _ => Err(ApiError::not_found()),
    }
}

/// `DELETE /ciphers/{id}/attachment/{attachmentId}` (and `POST …/delete`).
pub async fn remove(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let view = VaultView::load(&server, &user.id).await?;
    let cipher = view.reach_to_edit(&cipher_id)?;
    if !server
        .db
        .bitwarden_delete_attachment_of(&cipher.id, &id)
        .await?
    {
        return Err(ApiError::not_found());
    }
    server
        .db
        .bitwarden_touch_any_cipher(&cipher.id, Utc::now())
        .await?;
    super::touch_cipher(&server, cipher).await?;
    Ok(Json(
        json!({ "cipher": render_one(&server, &user.id, &cipher_id).await? }),
    ))
}
