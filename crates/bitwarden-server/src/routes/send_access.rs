//! Reaching a Send by its link (ADR 0148), signed out. The ciphertext is
//! given out only while the Send is enabled, unexpired, not deleted, under its
//! access limit, and — when it has one — after its password. A Send's password
//! arrives as the client's own hash of it and is checked like a master
//! password; wrong attempts are limited per Send.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenSend;
use serde_json::{json, Map, Value};

use super::credentials::text;
use super::file_links::download_url;
use crate::error::{ApiError, ApiResult};
use crate::wire::account::date;
use crate::wire::cipher::normalize;
use crate::wire::send::{file_json, id_from_access, stored, TEXT};
use crate::BitwardenServer;

const ACCESS_AUDIENCE: &str = "opensesame.bitwarden.send-access";
const ACCESS_TOKEN_SECONDS: i64 = 5 * 60;

/// A Send anyone may open right now: enabled, unexpired, not deleted, under
/// its access limit, and uploaded.
async fn available(server: &BitwardenServer, id: &str) -> ApiResult<Option<BitwardenSend>> {
    let now = Utc::now();
    Ok(server.db.bitwarden_send(id).await?.filter(|s| {
        s.uploaded
            && !s.disabled
            && s.deletion_at > now
            && s.expiration_at.is_none_or(|at| at > now)
            && s.max_access_count.is_none_or(|max| s.access_count < max)
    }))
}

/// Whether `offered` is the Send's password, counting failures per Send.
async fn password_matches(
    server: &BitwardenServer,
    send: &BitwardenSend,
    offered: &str,
) -> ApiResult<bool> {
    let Some(stored) = &send.password_hash else {
        return Ok(true);
    };
    let key = format!("send:{}", send.id);
    if server.sign_in_failures.blocked(&key) {
        return Err(ApiError::too_many_requests());
    }
    if server.check_secret_only(stored, offered).await? {
        server.sign_in_failures.clear(&key);
        Ok(true)
    } else {
        server.sign_in_failures.record_failure(&key);
        Ok(false)
    }
}

/// An available Send whose password, if it has one, the body proves.
/// Every refusal but the password's is "not found".
async fn open(
    server: &BitwardenServer,
    id: &str,
    body: &Map<String, Value>,
) -> ApiResult<BitwardenSend> {
    let send = available(server, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if send.password_hash.is_none() {
        return Ok(send);
    }
    let Some(offered) = text(body, "password") else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Password is required.",
        ));
    };
    if password_matches(server, &send, &offered).await? {
        Ok(send)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "Invalid password."))
    }
}

/// `grant_type=send_access` at `/identity/connect/token`: current clients
/// prove a Send's password once, here, and spend the short-lived token that
/// comes back at `/sends/access`.
pub(crate) async fn access_grant(
    server: &BitwardenServer,
    form: &std::collections::HashMap<String, String>,
) -> ApiResult<Json<Value>> {
    let access = form
        .get("send_id")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ApiError::send_access("invalid_request", "send_id_required"))?;
    let invalid = || ApiError::send_access("invalid_grant", "send_id_invalid");
    let id = id_from_access(access).ok_or_else(invalid)?;
    let send = available(server, &id).await?.ok_or_else(invalid)?;
    if send.password_hash.is_some() {
        let offered = form
            .get("password_hash_b64")
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                ApiError::send_access("invalid_request", "password_hash_b64_required")
            })?;
        if !password_matches(server, &send, offered).await? {
            return Err(ApiError::send_access(
                "invalid_grant",
                "password_hash_b64_invalid",
            ));
        }
    }
    let token = server
        .tokens
        .mint_purpose(&send.id, ACCESS_AUDIENCE, ACCESS_TOKEN_SECONDS)?;
    Ok(Json(json!({
        "access_token": token,
        "expires_in": ACCESS_TOKEN_SECONDS,
        "token_type": "Bearer",
        "scope": "api.send.access",
    })))
}

/// The Send a bearer Send-access token names, if it is still available.
async fn by_token(
    server: &BitwardenServer,
    headers: &axum::http::HeaderMap,
) -> ApiResult<BitwardenSend> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    let id = server
        .tokens
        .purpose_subject(token, ACCESS_AUDIENCE)
        .ok_or_else(ApiError::unauthorized)?;
    available(server, &id)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn creator(server: &BitwardenServer, send: &BitwardenSend) -> ApiResult<Option<String>> {
    if send.hide_email {
        return Ok(None);
    }
    Ok(server
        .db
        .bitwarden_user_by_id(&send.user_id)
        .await?
        .map(|user| user.email))
}

/// `POST /sends/access/{accessId}`, signed out: the Send's ciphertext. A text
/// Send counts the access here; a file Send when its file is fetched.
pub async fn access(
    State(server): State<BitwardenServer>,
    Path(access): Path<String>,
    body: Option<Json<Value>>,
) -> ApiResult<Json<Value>> {
    let id = id_from_access(&access).ok_or_else(ApiError::not_found)?;
    let body = normalize(body.map_or(Value::Null, |Json(b)| b));
    let send = open(&server, &id, &body).await?;
    if send.send_type == TEXT
        && !server
            .db
            .bitwarden_count_send_access(&send.id, send.access_count)
            .await?
    {
        return Err(ApiError::not_found());
    }
    access_json(&server, &send).await
}

async fn access_json(server: &BitwardenServer, send: &BitwardenSend) -> ApiResult<Json<Value>> {
    let data = stored(send);
    Ok(Json(json!({
        "id": send.id,
        "type": send.send_type,
        "name": data["name"],
        "text": if send.send_type == TEXT { data["text"].clone() } else { Value::Null },
        "file": file_json(send, &data),
        "expirationDate": send.expiration_at.map(date),
        "creatorIdentifier": creator(server, send).await?,
        "object": "send-access",
    })))
}

/// `POST /sends/access` with a Send-access token: the Send's ciphertext.
pub async fn access_with_token(
    State(server): State<BitwardenServer>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Json<Value>> {
    let send = by_token(&server, &headers).await?;
    if send.send_type == TEXT
        && !server
            .db
            .bitwarden_count_send_access(&send.id, send.access_count)
            .await?
    {
        return Err(ApiError::not_found());
    }
    access_json(&server, &send).await
}

/// `POST /sends/access/file/{fileId}` with a Send-access token.
pub async fn access_file_with_token(
    State(server): State<BitwardenServer>,
    headers: axum::http::HeaderMap,
    Path(file): Path<String>,
) -> ApiResult<Json<Value>> {
    let send = by_token(&server, &headers).await?;
    file_download(&server, &send, &file).await
}

async fn file_download(
    server: &BitwardenServer,
    send: &BitwardenSend,
    file: &str,
) -> ApiResult<Json<Value>> {
    if send.file_id.as_deref() != Some(file)
        || !server
            .db
            .bitwarden_count_send_access(&send.id, send.access_count)
            .await?
    {
        return Err(ApiError::not_found());
    }
    Ok(Json(json!({
        "id": file,
        "url": download_url(server, &send.id, file)?,
        "object": "send-fileDownload",
    })))
}

/// `POST /sends/{id}/access/file/{fileId}`, signed out: a download link for a
/// file Send's ciphertext, counting the access.
pub async fn access_file(
    State(server): State<BitwardenServer>,
    Path((id, file)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body.map_or(Value::Null, |Json(b)| b));
    let send = open(&server, &id, &body).await?;
    file_download(&server, &send, &file).await
}
