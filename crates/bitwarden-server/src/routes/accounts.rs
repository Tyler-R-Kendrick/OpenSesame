//! `/api/accounts`: profile, revision date, keys, and master-password changes.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map, Value};

use super::credentials::{self, text, Names};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::kdf::KdfConfig;
use crate::tokens::new_security_stamp;
use crate::wire::account::profile as profile_json;
use crate::wire::cipher::{is_enc_string, normalize};
use crate::BitwardenServer;
use opensesame_storage::bitwarden::{BitwardenCredentials, BitwardenUser};

pub async fn profile(Authed { user, .. }: Authed) -> Json<Value> {
    Json(profile_json(&user))
}

/// Epoch milliseconds; a client syncs when this moves.
pub async fn revision_date(Authed { user, .. }: Authed) -> Json<i64> {
    Json(user.revision_at.timestamp_millis())
}

/// Every sensitive account change re-proves the current master password.
pub(crate) async fn prove_password(
    server: &BitwardenServer,
    user: &BitwardenUser,
    body: &Map<String, Value>,
) -> ApiResult<()> {
    let secret = text(body, "masterPasswordHash").ok_or_else(ApiError::invalid_password)?;
    if server
        .check_secret(&user.id, &user.master_password_hash, &secret)
        .await?
    {
        Ok(())
    } else {
        Err(ApiError::invalid_password())
    }
}

pub async fn verify_password(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    prove_password(&server, &user, &normalize(body)).await?;
    Ok(Json(json!({ "object": "masterPasswordPolicy" })))
}

/// "Log out all sessions": rotate the stamp.
pub async fn security_stamp(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    prove_password(&server, &user, &normalize(body)).await?;
    server
        .db
        .bitwarden_rotate_security_stamp(&user.id, &new_security_stamp())
        .await?;
    Ok(StatusCode::OK)
}

fn keys_json(user: &BitwardenUser) -> Value {
    json!({
        "key": user.user_key,
        "publicKey": user.public_key,
        "privateKey": user.private_key,
        "object": "keys",
    })
}

pub async fn keys(Authed { user, .. }: Authed) -> Json<Value> {
    Json(keys_json(&user))
}

/// Set a key pair on an account that has none. An existing pair is never
/// overwritten here; replacing one is key rotation, which is not served.
pub async fn set_keys(
    State(server): State<BitwardenServer>,
    Authed { mut user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let body = normalize(body);
    if user.private_key.is_some() {
        return Err(ApiError::bad_request("User has existing keypair."));
    }
    let public_key = credentials::require(&body, "publicKey")?;
    let private_key = credentials::require(&body, "encryptedPrivateKey")?;
    if !is_enc_string(&private_key) {
        return Err(ApiError::bad_request(
            "The private key is not a valid encrypted string.",
        ));
    }
    server
        .db
        .bitwarden_set_keys(&user.id, &public_key, &private_key)
        .await?;
    user.public_key = Some(public_key);
    user.private_key = Some(private_key);
    Ok(Json(keys_json(&user)))
}

async fn replace(
    server: &BitwardenServer,
    user: &BitwardenUser,
    body: &Map<String, Value>,
    current: Option<KdfConfig>,
) -> ApiResult<()> {
    prove_password(server, user, body).await?;
    let names = Names {
        authentication: "authenticationData",
        unlock: "unlockData",
        flat_hash: "newMasterPasswordHash",
        flat_key: "key",
    };
    let new = credentials::read(body, &names, &user.email, server.config.kdf, current)?;
    let replacement = BitwardenCredentials {
        master_password_hash: server.hash_secret(&new.auth_hash).await?,
        kdf: new.kdf.to_stored(),
        user_key: new.wrapped_key,
        security_stamp: new_security_stamp(),
    };
    server
        .db
        .bitwarden_replace_credentials(&user.id, &replacement)
        .await?;
    Ok(())
}

/// Change the client KDF — e.g. PBKDF2 to Argon2id. The client re-derives the
/// master key under the new KDF and re-wraps the same user key, so no cipher
/// changes; every other session is signed out.
pub async fn change_kdf(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    replace(&server, &user, &normalize(body), None).await?;
    tracing::info!("bitwarden-compat account changed its KDF");
    Ok(StatusCode::OK)
}

/// Change the master password under the account's current KDF.
pub async fn change_password(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    replace(
        &server,
        &user,
        &body,
        Some(KdfConfig::from_stored(user.kdf)),
    )
    .await?;
    if body.contains_key("masterPasswordHint") {
        server
            .db
            .bitwarden_set_hint(&user.id, text(&body, "masterPasswordHint").as_deref())
            .await?;
    }
    Ok(StatusCode::OK)
}

/// `/api/accounts/key-management/user-key-id`: a client records the id it
/// computed for the user key, once, so every other client can see which key
/// is current. The server keeps it and never interprets it.
pub async fn set_user_key_id(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let key_id = text(&body, "userKeyId")
        .filter(|id| id.len() <= 256)
        .ok_or_else(|| ApiError::bad_request("The UserKeyId field is required."))?;
    server
        .db
        .bitwarden_set_user_key_id(&user.id, &key_id)
        .await?;
    Ok(StatusCode::OK)
}
