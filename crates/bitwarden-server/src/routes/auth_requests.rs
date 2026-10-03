//! "Log in with device" (ADR 0148 §8). A device that does not hold the
//! master password asks; one of the account's signed-in devices shows the
//! request's fingerprint phrase and, if the person approves, wraps the user
//! key under the asking device's public key. The asking device fetches that
//! wrap with an access code only it holds, then signs in with the same code
//! once (`authRequest` on the password grant) — within fifteen minutes of
//! asking, and never again.
//!
//! The server never sees the user key or the code: it keeps the wrap and a
//! digest. An address with no account gets a well-formed request that no
//! device will ever answer, so asking reveals nothing about who has one.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use opensesame_storage::bitwarden::{BitwardenAuthRequest, BitwardenUser};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;

use super::credentials::text;
use super::folders::list_json;
use super::identity::normalize_email;
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::wire::account::date;
use crate::wire::cipher::{is_enc_string, normalize};
use crate::BitwardenServer;

/// How long a request stays open, to be answered and then spent.
pub(crate) const WINDOW_MINUTES: i64 = 15;
/// Unanswered requests one account may have open at once.
pub(crate) const MAX_PENDING: i64 = 5;

pub(super) fn routes() -> Router<BitwardenServer> {
    Router::new()
        .route("/auth-requests", get(pending).post(create))
        .route("/auth-requests/", post(create))
        .route("/auth-requests/pending", get(pending))
        .route("/auth-requests/{id}", get(get_one).put(answer))
        .route("/auth-requests/{id}/response", get(response))
}

/// When the open window began: requests made before it are gone.
pub(crate) fn window_start() -> chrono::DateTime<Utc> {
    Utc::now() - Duration::minutes(WINDOW_MINUTES)
}

/// How much longer a request made at `created_at` stays open.
pub(crate) fn time_left(created_at: chrono::DateTime<Utc>) -> std::time::Duration {
    (created_at + Duration::minutes(WINDOW_MINUTES) - Utc::now())
        .to_std()
        .unwrap_or_default()
}

fn digest(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}

/// Whether `code` is the one the request was made with.
fn code_matches(request: &BitwardenAuthRequest, code: &str) -> bool {
    bool::from(
        digest(code)
            .as_bytes()
            .ct_eq(request.access_code_digest.as_bytes()),
    )
}

/// Bitwarden's device types, as its clients name them in the prompt.
fn device_name(device_type: i64) -> &'static str {
    const NAMES: [&str; 26] = [
        "Android",
        "iOS",
        "Chrome Extension",
        "Firefox Extension",
        "Opera Extension",
        "Edge Extension",
        "Windows",
        "macOS",
        "Linux",
        "Chrome",
        "Firefox",
        "Opera",
        "Edge",
        "Internet Explorer",
        "Unknown Browser",
        "Android",
        "Windows",
        "Safari",
        "Vivaldi",
        "Vivaldi Extension",
        "Safari Extension",
        "SDK",
        "Server",
        "Windows CLI",
        "macOS CLI",
        "Linux CLI",
    ];
    usize::try_from(device_type)
        .ok()
        .and_then(|i| NAMES.get(i))
        .copied()
        .unwrap_or("Unknown")
}

fn request_json(server: &BitwardenServer, request: &BitwardenAuthRequest) -> Value {
    json!({
        "id": request.id,
        "publicKey": request.public_key,
        "requestDeviceType": device_name(request.device_type),
        "requestDeviceTypeValue": request.device_type,
        "requestDeviceIdentifier": request.device_identifier,
        "requestIpAddress": null,
        "requestCountryName": null,
        "key": request.key,
        "masterPasswordHash": request.master_password_hash,
        "creationDate": date(request.created_at),
        "responseDate": request.response_at.map(date),
        "requestApproved": request.approved,
        "origin": server.config.public_url,
        "object": "auth-request",
    })
}

fn device_type(headers: &HeaderMap, body: &serde_json::Map<String, Value>) -> i64 {
    headers
        .get("device-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .or_else(|| body.get("deviceType").and_then(Value::as_i64))
        .unwrap_or(14)
}

/// `POST /auth-requests`: `{email, publicKey, deviceIdentifier, accessCode,
/// type}`, unauthenticated.
async fn create(
    State(server): State<BitwardenServer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    let email = normalize_email(&text(&body, "email").unwrap_or_default());
    let public_key = text(&body, "publicKey").filter(|k| !k.is_empty() && k.len() <= 2048);
    let identifier = text(&body, "deviceIdentifier").filter(|d| !d.is_empty() && d.len() <= 256);
    let code = text(&body, "accessCode").filter(|c| (10..=128).contains(&c.len()));
    let (Some(public_key), Some(identifier), Some(code)) = (public_key, identifier, code) else {
        return Err(ApiError::bad_request("The request is incomplete."));
    };
    // Every address is charged the same, whether or not it has an account, so
    // the answer to "too many" says nothing about who does. The count is its
    // own: failed passwords neither spend it nor are blocked by it.
    if server.sign_in_requests.blocked(&email) {
        return Err(ApiError::too_many_requests());
    }
    server.sign_in_requests.record_failure(&email);
    let user = server.db.bitwarden_user_by_email(&email).await?;
    let request = BitwardenAuthRequest {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user.as_ref().map_or_else(String::new, |u| u.id.clone()),
        device_identifier: identifier,
        device_type: device_type(&headers, &body),
        access_code_digest: digest(&code),
        public_key,
        key: None,
        master_password_hash: None,
        approved: None,
        response_device: None,
        created_at: Utc::now(),
        response_at: None,
    };
    if let Some(user) = &user {
        if !server
            .db
            .bitwarden_add_auth_request(&request, window_start(), MAX_PENDING)
            .await?
        {
            return Err(ApiError::too_many_requests());
        }
        server.hub.sign_in_requested(&user.id, &request.id);
    }
    Ok(Json(request_json(&server, &request)))
}

async fn owned(
    server: &BitwardenServer,
    user: &BitwardenUser,
    id: &str,
) -> ApiResult<BitwardenAuthRequest> {
    server
        .db
        .bitwarden_auth_request(id, window_start())
        .await?
        .filter(|r| r.user_id == user.id)
        .ok_or_else(ApiError::not_found)
}

/// `GET /auth-requests/pending`: the account's unanswered requests.
async fn pending(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
) -> ApiResult<Json<Value>> {
    let open: Vec<Value> = server
        .db
        .bitwarden_auth_requests(&user.id, window_start())
        .await?
        .iter()
        .filter(|r| r.approved.is_none())
        .map(|r| request_json(&server, r))
        .collect();
    Ok(Json(list_json(&open)))
}

/// `GET /auth-requests/{id}`: one of the account's requests.
async fn get_one(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(request_json(
        &server,
        &owned(&server, &user, &id).await?,
    )))
}

/// `PUT /auth-requests/{id}`: `{key, masterPasswordHash, deviceIdentifier,
/// requestApproved}` from one of the account's own devices. Approving
/// stores the user key wrapped for the asking device; denying deletes the
/// request.
async fn answer(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let request = owned(&server, &user, &id).await?;
    let body = normalize(body);
    if request.approved.is_some() {
        return Err(ApiError::bad_request("This request was already answered."));
    }
    if !body
        .get("requestApproved")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        server
            .db
            .bitwarden_delete_auth_request(&user.id, &id)
            .await?;
        server.hub.sign_in_ended(&id);
        return Ok(Json(request_json(&server, &request)));
    }
    let key = text(&body, "key")
        .filter(|k| is_enc_string(k))
        .ok_or_else(|| ApiError::bad_request("The key must be encrypted."))?;
    let master = text(&body, "masterPasswordHash").filter(|h| is_enc_string(h));
    let responder = text(&body, "deviceIdentifier").unwrap_or_default();
    if !server
        .db
        .bitwarden_approve_auth_request(&user.id, &id, &key, master.as_deref(), &responder)
        .await?
    {
        return Err(ApiError::bad_request("This request was already answered."));
    }
    server.hub.sign_in_answered(&user.id, &id);
    Ok(Json(request_json(
        &server,
        &owned(&server, &user, &id).await?,
    )))
}

#[derive(Deserialize)]
struct CodeQuery {
    code: String,
}

/// `GET /auth-requests/{id}/response?code=…`: the answer, to the device
/// holding the request's access code, unauthenticated.
async fn response(
    State(server): State<BitwardenServer>,
    Path(id): Path<String>,
    Query(query): Query<CodeQuery>,
) -> ApiResult<Json<Value>> {
    let limit = format!("auth-request:{id}");
    if server.sign_in_failures.blocked(&limit) {
        return Err(ApiError::too_many_requests());
    }
    match server
        .db
        .bitwarden_auth_request(&id, window_start())
        .await?
    {
        Some(request) if code_matches(&request, &query.code) => {
            Ok(Json(request_json(&server, &request)))
        }
        _ => {
            server.sign_in_failures.record_failure(&limit);
            Err(ApiError::not_found())
        }
    }
}

/// Whether `code` spends an approved request of `user`: the password grant
/// with `authRequest`. Spent exactly once.
///
/// # Errors
///
/// Returns an error when the database fails.
pub(crate) async fn spend(
    server: &BitwardenServer,
    user: &BitwardenUser,
    id: &str,
    code: &str,
) -> ApiResult<bool> {
    let approved = server
        .db
        .bitwarden_auth_request(id, window_start())
        .await?
        .filter(|r| r.user_id == user.id && r.approved == Some(true) && code_matches(r, code));
    if approved.is_none() {
        return Ok(false);
    }
    Ok(server
        .db
        .bitwarden_delete_auth_request(&user.id, id)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_stays_open_for_its_window_and_not_a_moment_more() {
        let fresh = time_left(Utc::now());
        assert!(fresh > std::time::Duration::from_secs(14 * 60));
        assert_eq!(
            time_left(Utc::now() - Duration::minutes(WINDOW_MINUTES + 1)),
            std::time::Duration::ZERO
        );
    }
}
