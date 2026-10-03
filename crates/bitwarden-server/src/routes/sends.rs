//! Sends (ADR 0148): the owner's routes. Anyone with a link reaches a Send
//! through `send_access`.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenSend, BitwardenUser};
use serde_json::{json, Value};

use super::file_links::file_id;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::normalize;
use crate::wire::send::{parse_send, send_json, stored, SendInput, FILE, TEXT};
use crate::BitwardenServer;

async fn owned(server: &BitwardenServer, user_id: &str, id: &str) -> ApiResult<BitwardenSend> {
    server
        .db
        .bitwarden_send(id)
        .await?
        .filter(|send| send.user_id == user_id)
        .ok_or_else(ApiError::not_found)
}

async fn create_send(
    server: &BitwardenServer,
    user: &BitwardenUser,
    input: SendInput,
    file: Option<(String, i64)>,
) -> ApiResult<BitwardenSend> {
    super::policy_rules::may_send(server, &user.id, input.hide_email).await?;
    let now = Utc::now();
    let password_hash = match &input.password {
        Some(password) => Some(server.hash_secret(password).await?),
        None => None,
    };
    let send = BitwardenSend {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user.id.clone(),
        send_type: input.send_type,
        data: input.data.to_string(),
        key: input.key,
        password_hash,
        max_access_count: input.max_access_count,
        access_count: 0,
        disabled: input.disabled,
        hide_email: input.hide_email,
        uploaded: file.is_none(),
        file_id: file.as_ref().map(|(id, _)| id.clone()),
        file_size: file.map(|(_, size)| size),
        created_at: now,
        revision_at: now,
        expiration_at: input.expiration_at,
        deletion_at: input.deletion_at,
    };
    server.db.bitwarden_put_send(&send).await?;
    super::touch(server, &user.id).await?;
    Ok(send)
}

/// `GET /sends`.
pub async fn list(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    server.db.bitwarden_purge_sends(Utc::now()).await?;
    let sends: Vec<Value> = server
        .db
        .bitwarden_sends(&user.id)
        .await?
        .iter()
        .map(send_json)
        .collect();
    Ok(Json(
        json!({ "data": sends, "object": "list", "continuationToken": null }),
    ))
}

/// The account's live Sends as `/sync` carries them.
pub(crate) async fn for_sync(server: &BitwardenServer, user_id: &str) -> ApiResult<Vec<Value>> {
    server.db.bitwarden_purge_sends(Utc::now()).await?;
    Ok(server
        .db
        .bitwarden_sends(user_id)
        .await?
        .iter()
        .filter(|send| send.uploaded)
        .map(send_json)
        .collect())
}

/// `GET /sends/{id}`.
pub async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(send_json(&owned(&server, &user.id, &id).await?)))
}

/// `POST /sends`: a text Send.
pub async fn create(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let input = parse_send(&normalize(body))?;
    if input.send_type != TEXT {
        return Err(ApiError::bad_request(
            "File sends are created with /sends/file/v2.",
        ));
    }
    Ok(Json(send_json(
        &create_send(&server, &user, input, None).await?,
    )))
}

fn upload_data(server: &BitwardenServer, send: &BitwardenSend) -> Value {
    json!({
        "url": format!(
            "{}/api/sends/{}/file/{}",
            server.config.public_url,
            send.id,
            send.file_id.clone().unwrap_or_default()
        ),
        "fileUploadType": 0,
        "sendResponse": send_json(send),
        "object": "send-fileUpload",
    })
}

/// `POST /sends/file/v2`: announce a file Send; upload it next.
pub async fn announce_file(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let input = parse_send(&body)?;
    if input.send_type != FILE {
        return Err(ApiError::bad_request("Only file sends are created here."));
    }
    let size = body.get("fileLength").and_then(Value::as_i64).unwrap_or(0);
    super::attachments::admit_size(&server, &user.id, size).await?;
    let send = create_send(&server, &user, input, Some((file_id(), size))).await?;
    Ok(Json(upload_data(&server, &send)))
}

/// `GET /sends/{id}/file/{fileId}`: the upload URL again.
pub async fn renew_file(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((id, file)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let send = owned(&server, &user.id, &id).await?;
    if send.uploaded || send.file_id.as_deref() != Some(file.as_str()) {
        return Err(ApiError::not_found());
    }
    Ok(Json(upload_data(&server, &send)))
}

/// `POST /sends/{id}/file/{fileId}`: the announced file's bytes.
pub async fn upload_file(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path((id, file)): Path<(String, String)>,
    form: Multipart,
) -> ApiResult<StatusCode> {
    let send = owned(&server, &user.id, &id).await?;
    // A file announced before the policy came on is not completed after it.
    super::policy_rules::may_send(&server, &user.id, send.hide_email).await?;
    let (data, _, _) = super::attachments::read_upload(form).await?;
    let length = i64::try_from(data.len()).unwrap_or(i64::MAX);
    if (length - send.file_size.unwrap_or(0)).abs() > super::attachments::SIZE_LEEWAY || length == 0
    {
        return Err(ApiError::bad_request("File size does not match."));
    }
    if !server
        .db
        .bitwarden_upload_send_file(&user.id, &id, &file, &data)
        .await?
    {
        return Err(ApiError::not_found());
    }
    super::touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}

/// `PUT /sends/{id}`. A password left out keeps the current one.
pub async fn update(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let current = owned(&server, &user.id, &id).await?;
    let input = parse_send(&normalize(body))?;
    super::policy_rules::may_send(&server, &user.id, input.hide_email).await?;
    if input.send_type != current.send_type {
        return Err(ApiError::bad_request("Sends cannot change type."));
    }
    let mut data = input.data;
    if current.send_type == FILE {
        // The file and its name are fixed at upload.
        data["file"] = stored(&current)["file"].clone();
    }
    let password_hash = match &input.password {
        Some(password) => Some(server.hash_secret(password).await?),
        None => current.password_hash.clone(),
    };
    let send = BitwardenSend {
        data: data.to_string(),
        key: input.key,
        password_hash,
        max_access_count: input.max_access_count,
        disabled: input.disabled,
        hide_email: input.hide_email,
        revision_at: Utc::now(),
        expiration_at: input.expiration_at,
        deletion_at: input.deletion_at,
        ..current
    };
    server.db.bitwarden_put_send(&send).await?;
    super::touch(&server, &user.id).await?;
    Ok(Json(send_json(&send)))
}

/// `PUT /sends/{id}/remove-password`.
pub async fn remove_password(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let current = owned(&server, &user.id, &id).await?;
    super::policy_rules::may_send(&server, &user.id, current.hide_email).await?;
    let send = BitwardenSend {
        password_hash: None,
        revision_at: Utc::now(),
        ..current
    };
    server.db.bitwarden_put_send(&send).await?;
    super::touch(&server, &user.id).await?;
    Ok(Json(send_json(&send)))
}

/// `DELETE /sends/{id}`.
pub async fn remove(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if !server.db.bitwarden_delete_send(&user.id, &id).await? {
        return Err(ApiError::not_found());
    }
    super::touch(&server, &user.id).await?;
    Ok(StatusCode::OK)
}
