//! Attachments (ADR 0148): files on a cipher, encrypted by the client under a
//! key the server never holds.
//!
//! A client announces a file (`/attachment/v2`: its encrypted name and key,
//! and its size), then uploads the ciphertext to the URL it is given; older
//! clients do both in one multipart request. A download is a URL carrying a
//! short-lived token, so a client can hand it to its file fetcher without its
//! own bearer token.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenAttachment, BitwardenCipher};
use serde_json::{json, Value};

use super::credentials::text;
use super::file_links::{download_url, file_id};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{cipher_json, is_enc_string, normalize};
use crate::wire::files::size_name;
use crate::BitwardenServer;

/// Declared and uploaded sizes may differ by this much (encryption padding).
pub(crate) const SIZE_LEEWAY: i64 = 1024 * 1024;

fn attachment_json(server: &BitwardenServer, attachment: &BitwardenAttachment) -> ApiResult<Value> {
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

/// Ciphers as clients read them, each with its uploaded attachments.
pub(crate) struct CipherViews {
    by_cipher: HashMap<String, Vec<Value>>,
}

impl CipherViews {
    pub(crate) async fn load(server: &BitwardenServer, user_id: &str) -> ApiResult<Self> {
        let mut by_cipher: HashMap<String, Vec<Value>> = HashMap::new();
        for attachment in server.db.bitwarden_attachments(user_id).await? {
            if attachment.uploaded {
                by_cipher
                    .entry(attachment.cipher_id.clone())
                    .or_default()
                    .push(attachment_json(server, &attachment)?);
            }
        }
        Ok(Self { by_cipher })
    }

    pub(crate) fn render(&self, cipher: &BitwardenCipher) -> Value {
        cipher_json(cipher, self.by_cipher.get(&cipher.id).map(Vec::as_slice))
    }
}

/// One cipher as clients read it.
pub(crate) async fn render(server: &BitwardenServer, cipher: &BitwardenCipher) -> ApiResult<Value> {
    Ok(CipherViews::load(server, &cipher.user_id)
        .await?
        .render(cipher))
}

async fn owned_cipher(
    server: &BitwardenServer,
    user_id: &str,
    id: &str,
) -> ApiResult<BitwardenCipher> {
    server
        .db
        .bitwarden_cipher(user_id, id)
        .await?
        .ok_or_else(ApiError::not_found)
}

/// A file of `size` bytes fits the per-file limit and the account's quota.
pub(crate) async fn admit_size(
    server: &BitwardenServer,
    user_id: &str,
    size: i64,
) -> ApiResult<()> {
    let limit = i64::try_from(server.config.max_file_bytes).unwrap_or(i64::MAX);
    if size <= 0 || size > limit {
        return Err(ApiError::bad_request(format!(
            "Max file size is {}.",
            size_name(limit)
        )));
    }
    let used = server.db.bitwarden_storage_used(user_id).await?;
    if used.saturating_add(size) > server.config.storage_quota_bytes {
        return Err(ApiError::bad_request("Not enough storage available."));
    }
    Ok(())
}

/// What a client needs to upload an announced file: where to, and the
/// cipher as it will read once the file lands, the new attachment included.
async fn upload_data(
    server: &BitwardenServer,
    cipher: &BitwardenCipher,
    attachment: &BitwardenAttachment,
) -> ApiResult<Json<Value>> {
    let mut view = render(server, cipher).await?;
    let pending = attachment_json(server, attachment)?;
    match view.get_mut("attachments") {
        Some(Value::Array(listed)) => listed.push(pending),
        _ => view["attachments"] = json!([pending]),
    }
    Ok(Json(json!({
        "attachmentId": attachment.id,
        "url": format!("{}/api/ciphers/{}/attachment/{}", server.config.public_url, cipher.id, attachment.id),
        "fileUploadType": 0,
        "cipherResponse": view,
        "cipherMiniResponse": view,
        "object": "attachment-fileUpload",
    })))
}

/// `POST /ciphers/{id}/attachment/v2`: announce a file; upload it next.
pub async fn announce(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(cipher_id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let cipher = owned_cipher(&server, &user.id, &cipher_id).await?;
    let file_name = text(&body, "fileName").filter(|n| is_enc_string(n));
    let key = text(&body, "key").filter(|k| is_enc_string(k));
    let (Some(file_name), Some(key)) = (file_name, key) else {
        return Err(ApiError::bad_request(
            "The file name and key must be encrypted.",
        ));
    };
    let size = body.get("fileSize").and_then(Value::as_i64).unwrap_or(0);
    admit_size(&server, &user.id, size).await?;
    let attachment = BitwardenAttachment {
        id: file_id(),
        cipher_id: cipher.id.clone(),
        user_id: user.id.clone(),
        file_name,
        key: Some(key),
        size,
        uploaded: false,
        created_at: Utc::now(),
    };
    server.db.bitwarden_add_attachment(&attachment).await?;
    upload_data(&server, &cipher, &attachment).await
}

/// `GET /ciphers/{id}/attachment/{attachmentId}/renew`: the upload URL again.
pub async fn renew(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let cipher = owned_cipher(&server, &user.id, &cipher_id).await?;
    match server
        .db
        .bitwarden_attachment(&user.id, &cipher_id, &id)
        .await?
    {
        Some(attachment) if !attachment.uploaded => {
            upload_data(&server, &cipher, &attachment).await
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
    user_id: &str,
    attachment: &BitwardenAttachment,
    data: &[u8],
) -> ApiResult<()> {
    let length = i64::try_from(data.len()).unwrap_or(i64::MAX);
    if length == 0 || (length - attachment.size).abs() > SIZE_LEEWAY {
        return Err(ApiError::bad_request("File size does not match."));
    }
    if !server
        .db
        .bitwarden_upload_attachment(user_id, &attachment.id, data)
        .await?
    {
        return Err(ApiError::bad_request(
            "This attachment was already uploaded.",
        ));
    }
    server
        .db
        .bitwarden_touch_cipher(user_id, &attachment.cipher_id, Utc::now())
        .await?;
    super::touch(server, user_id).await?;
    Ok(())
}

/// `POST /ciphers/{id}/attachment/{attachmentId}`: the announced file's bytes.
pub async fn upload(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
    form: Multipart,
) -> ApiResult<StatusCode> {
    let attachment = server
        .db
        .bitwarden_attachment(&user.id, &cipher_id, &id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let (data, _, _) = read_upload(form).await?;
    store(&server, &user.id, &attachment, &data).await?;
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
    let cipher = owned_cipher(&server, &user.id, &cipher_id).await?;
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
    admit_size(&server, &user.id, size).await?;
    let attachment = BitwardenAttachment {
        id: file_id(),
        cipher_id: cipher.id.clone(),
        user_id: user.id.clone(),
        file_name,
        key: Some(key),
        size,
        uploaded: false,
        created_at: Utc::now(),
    };
    server.db.bitwarden_add_attachment(&attachment).await?;
    store(&server, &user.id, &attachment, &data).await?;
    let cipher = owned_cipher(&server, &user.id, &cipher_id).await?;
    Ok(Json(render(&server, &cipher).await?))
}

/// `GET /ciphers/{id}/attachment/{attachmentId}`: metadata and a fresh link.
pub async fn describe(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((cipher_id, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    match server
        .db
        .bitwarden_attachment(&user.id, &cipher_id, &id)
        .await?
    {
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
    if !server
        .db
        .bitwarden_delete_attachment(&user.id, &cipher_id, &id)
        .await?
    {
        return Err(ApiError::not_found());
    }
    server
        .db
        .bitwarden_touch_cipher(&user.id, &cipher_id, Utc::now())
        .await?;
    super::touch(&server, &user.id).await?;
    let cipher = owned_cipher(&server, &user.id, &cipher_id).await?;
    Ok(Json(json!({ "cipher": render(&server, &cipher).await? })))
}
