//! `/identity`: prelogin and the OAuth token endpoint.

use std::collections::HashMap;

use axum::extract::State;
use axum::{Form, Json};
use chrono::{DateTime, Utc};
use opensesame_storage::bitwarden::BitwardenSignIn;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::kdf::KdfConfig;
use crate::tokens::{new_refresh_token, refresh_token_hash};
use crate::wire::account::token_body;
use crate::BitwardenServer;

/// Bitwarden salts with the trimmed, lower-cased email.
#[must_use]
pub fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

#[derive(Deserialize)]
pub struct PreloginRequest {
    #[serde(alias = "Email")]
    email: String,
}

/// Both prelogin routes. The flat members serve older clients, `kdfSettings`
/// and `salt` current ones. An unknown email gets the policy default, the
/// same answer a known account with that setting would get.
pub async fn prelogin(
    State(server): State<BitwardenServer>,
    Json(request): Json<PreloginRequest>,
) -> ApiResult<Json<Value>> {
    let email = normalize_email(&request.email);
    let kdf = server
        .db
        .bitwarden_user_by_email(&email)
        .await?
        .map_or(server.config.kdf.default, |user| {
            KdfConfig::from_stored(user.kdf)
        });
    let mut body = kdf.flat_json();
    body["kdfSettings"] = kdf.settings_json();
    body["salt"] = json!(email);
    Ok(Json(body))
}

fn required<'a>(form: &'a HashMap<String, String>, key: &str) -> ApiResult<&'a str> {
    form.get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::oauth("invalid_request", format!("{key} is required.")))
}

fn refresh_expiry(server: &BitwardenServer) -> DateTime<Utc> {
    let ttl = chrono::Duration::from_std(server.config.refresh_token_ttl)
        .unwrap_or_else(|_| chrono::Duration::days(30));
    Utc::now() + ttl
}

/// `POST /identity/connect/token`.
pub async fn token(
    State(server): State<BitwardenServer>,
    Form(form): Form<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    match form.get("grant_type").map(String::as_str) {
        Some("password") => password_grant(&server, &form).await,
        Some("refresh_token") => refresh_grant(&server, &form).await,
        _ => Err(ApiError::oauth(
            "unsupported_grant_type",
            "This server supports the password and refresh_token grants.",
        )),
    }
}

async fn password_grant(
    server: &BitwardenServer,
    form: &HashMap<String, String>,
) -> ApiResult<Json<Value>> {
    let email = normalize_email(required(form, "username")?);
    let secret = required(form, "password")?;
    let identifier = required(form, "deviceIdentifier")?;
    let client_id = required(form, "client_id")?;
    let device_name = form.get("deviceName").map_or("unknown", String::as_str);
    let device_type = form
        .get("deviceType")
        .and_then(|raw| raw.parse::<i64>().ok())
        .unwrap_or(14);

    // Refused before any hash is spent; known and unknown addresses alike.
    if server.sign_in_failures.blocked(&email) {
        return Err(ApiError::too_many_requests());
    }
    let Some(user) = server.db.bitwarden_user_by_email(&email).await? else {
        server.decoy_check(secret).await?;
        server.sign_in_failures.record_failure(&email);
        return Err(ApiError::invalid_grant());
    };
    if !server
        .check_secret(&user.id, &user.master_password_hash, secret)
        .await?
    {
        server.sign_in_failures.record_failure(&email);
        return Err(ApiError::invalid_grant());
    }
    server.sign_in_failures.clear(&email);
    let refresh = new_refresh_token();
    let device_id = server
        .db
        .bitwarden_upsert_device(&BitwardenSignIn {
            user_id: &user.id,
            identifier,
            name: device_name,
            device_type,
            refresh_token_hash: &refresh_token_hash(&refresh),
            // The stamp this sign-in verified under. A password change that
            // lands before this write leaves the token already dead.
            security_stamp: &user.security_stamp,
            refresh_expires_at: refresh_expiry(server),
        })
        .await?;
    let access = server.tokens.mint_access(&user, &device_id, client_id)?;
    Ok(Json(token_body(
        &user,
        &access,
        server.tokens.access_ttl_seconds(),
        &refresh,
    )))
}

async fn refresh_grant(
    server: &BitwardenServer,
    form: &HashMap<String, String>,
) -> ApiResult<Json<Value>> {
    let refresh = required(form, "refresh_token")?;
    let refused = || ApiError::oauth("invalid_grant", "invalid_grant");
    let device = server
        .db
        .bitwarden_device_by_refresh(&refresh_token_hash(refresh))
        .await?
        .ok_or_else(refused)?;
    let user = server
        .db
        .bitwarden_user_by_id(&device.user_id)
        .await?
        .ok_or_else(refused)?;
    // Issued under an older stamp (a password, KDF or "log out everywhere"
    // change since), or unused for longer than its lifetime: refused.
    let current = device.refresh_stamp.as_deref() == Some(user.security_stamp.as_str());
    let live = device
        .refresh_expires_at
        .is_some_and(|expires| expires > Utc::now());
    if !current || !live {
        return Err(refused());
    }
    server
        .db
        .bitwarden_extend_refresh(&device.id, refresh_expiry(server))
        .await?;
    let client_id = form.get("client_id").map_or("unknown", String::as_str);
    let access = server.tokens.mint_access(&user, &device.id, client_id)?;
    Ok(Json(json!({
        "access_token": access,
        "expires_in": server.tokens.access_ttl_seconds(),
        "token_type": "Bearer",
        "refresh_token": refresh,
        "scope": "api offline_access",
    })))
}
