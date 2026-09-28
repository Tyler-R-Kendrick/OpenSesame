//! `POST /api/accounts/key-management/rotate-user-account-keys` (ADR 0148
//! §6): replace the user key.
//!
//! The client re-encrypts everything the old key protected and sends all of
//! it at once, with the master password it proves. The server refuses a
//! rotation that leaves anything behind — a personal cipher, folder, Send,
//! emergency contact's key or account-recovery key the account has but the
//! request does not carry — because what it left would be unreadable. It
//! refuses a change of KDF, address or key pair (those have their own
//! endpoints), and it writes everything in one transaction.

use std::collections::HashSet;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use opensesame_storage::bitwarden::{
    emergency_status, BitwardenCredentials, BitwardenKdf, BitwardenKeyRotation, BitwardenUser,
    RotatedCipher,
};
use serde_json::{Map, Value};

use super::credentials::{require, text};
use crate::auth::Authed;
use crate::error::{ApiError, ApiResult};
use crate::tokens::new_security_stamp;
use crate::wire::cipher::{folder_name, is_enc_string, normalize, parse_cipher};
use crate::wire::send::{parse_send, stored, FILE};
use crate::BitwardenServer;

fn object(body: &Map<String, Value>, key: &str) -> Map<String, Value> {
    normalize(body.get(key).cloned().unwrap_or(Value::Null))
}

fn items(body: &Map<String, Value>, key: &str) -> Vec<Map<String, Value>> {
    body.get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().cloned().map(normalize).collect())
        .unwrap_or_default()
}

fn missing(what: &str) -> ApiError {
    ApiError::bad_request(format!(
        "All existing {what} must be included in the rotation."
    ))
}

/// Every id in `have` appears in `given`.
fn covers(have: impl IntoIterator<Item = String>, given: &HashSet<String>) -> bool {
    have.into_iter().all(|id| given.contains(&id))
}

/// The KDF as the unlock data states it, flat or nested.
fn stated_kdf(unlock: &Map<String, Value>) -> BitwardenKdf {
    let nested = object(unlock, "kdf");
    let int = |flat: &str, inner: &str| {
        unlock
            .get(flat)
            .and_then(Value::as_i64)
            .or_else(|| nested.get(inner).and_then(Value::as_i64))
    };
    BitwardenKdf {
        kdf_type: int("kdfType", "kdfType").unwrap_or(-1),
        iterations: int("kdfIterations", "iterations").unwrap_or(-1),
        memory: int("kdfMemory", "memory"),
        parallelism: int("kdfParallelism", "parallelism"),
    }
}

/// The new wrap of the private key, and a public key that must be the
/// account's current one.
fn account_keys(user: &BitwardenUser, body: &Map<String, Value>) -> ApiResult<String> {
    let keys = object(body, "accountKeys");
    let pair = object(&keys, "publicKeyEncryptionKeyPair");
    let private = text(&keys, "userKeyEncryptedAccountPrivateKey")
        .or_else(|| text(&pair, "wrappedPrivateKey"))
        .filter(|k| is_enc_string(k))
        .ok_or_else(|| ApiError::bad_request("The private key must be encrypted."))?;
    let public = text(&keys, "accountPublicKey").or_else(|| text(&pair, "publicKey"));
    if public.is_none() || public != user.public_key {
        return Err(ApiError::bad_request(
            "Changing the asymmetric keypair is not possible during key rotation.",
        ));
    }
    Ok(private)
}

async fn ciphers(
    server: &BitwardenServer,
    user: &BitwardenUser,
    data: &Map<String, Value>,
) -> ApiResult<Vec<RotatedCipher>> {
    let mut out = Vec::new();
    for cipher in items(data, "ciphers") {
        let org = text(&cipher, "organizationId").filter(|o| !o.is_empty());
        if org.is_some() {
            continue; // organization ciphers are under the organization's key
        }
        let id = require(&cipher, "id")?;
        let input = parse_cipher(Value::Object(cipher), &user.id)?;
        out.push(RotatedCipher {
            id,
            cipher_type: input.cipher_type,
            data: input.data.to_string(),
        });
    }
    let given: HashSet<String> = out.iter().map(|c| c.id.clone()).collect();
    let have = server.db.bitwarden_ciphers(&user.id).await?;
    if !covers(have.into_iter().map(|c| c.id), &given) {
        return Err(missing("ciphers"));
    }
    Ok(out)
}

async fn folders(
    server: &BitwardenServer,
    user_id: &str,
    data: &Map<String, Value>,
) -> ApiResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    // Some clients send a `null` folder entry; it names nothing.
    for folder in items(data, "folders") {
        let Some(id) = text(&folder, "id").filter(|id| !id.is_empty()) else {
            continue;
        };
        out.push((id, folder_name(Value::Object(folder))?));
    }
    let given: HashSet<String> = out.iter().map(|(id, _)| id.clone()).collect();
    let have = server.db.bitwarden_folders(user_id).await?;
    if !covers(have.into_iter().map(|f| f.id), &given) {
        return Err(missing("folders"));
    }
    Ok(out)
}

async fn sends(
    server: &BitwardenServer,
    user_id: &str,
    data: &Map<String, Value>,
) -> ApiResult<Vec<(String, String, String)>> {
    let have = server.db.bitwarden_sends(user_id).await?;
    let mut out = Vec::new();
    for send in items(data, "sends") {
        let id = require(&send, "id")?;
        let current = have
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| ApiError::bad_request("Send doesn't exist."))?;
        let input = parse_send(&send)?;
        let mut body = input.data;
        if current.send_type == FILE {
            // The file and its name are fixed at upload.
            body["file"] = stored(current)["file"].clone();
        }
        out.push((id, input.key, body.to_string()));
    }
    let given: HashSet<String> = out.iter().map(|(id, _, _)| id.clone()).collect();
    if !covers(have.into_iter().map(|s| s.id), &given) {
        return Err(missing("sends"));
    }
    Ok(out)
}

/// `(id, key)` pairs from `list`, each key an `EncString`, covering `have`.
fn keyed(
    list: Vec<Map<String, Value>>,
    id_key: &str,
    key_key: &str,
    have: Vec<String>,
    what: &str,
) -> ApiResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for item in list {
        let key = require(&item, key_key)?;
        if !is_enc_string(&key) {
            return Err(ApiError::bad_request("A rotated key is not encrypted."));
        }
        out.push((require(&item, id_key)?, key));
    }
    let given: HashSet<String> = out.iter().map(|(id, _)| id.clone()).collect();
    if !covers(have, &given) {
        return Err(missing(what));
    }
    Ok(out)
}

pub async fn rotate(
    State(server): State<BitwardenServer>,
    Authed { user, .. }: Authed,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let body = normalize(body);
    let old = text(&body, "oldMasterKeyAuthenticationHash").unwrap_or_default();
    if !server
        .check_secret(&user.id, &user.master_password_hash, &old)
        .await?
    {
        return Err(ApiError::invalid_password());
    }
    let unlock = object(&body, "accountUnlockData");
    let master = object(&unlock, "masterPasswordUnlockData");
    let salt = text(&master, "email").or_else(|| text(&master, "salt"));
    if stated_kdf(&master) != user.kdf || salt.as_deref() != Some(user.email.as_str()) {
        return Err(ApiError::bad_request(
            "Changing the kdf variant or email is not supported during key rotation.",
        ));
    }
    let wrapped = require(&master, "masterKeyEncryptedUserKey")?;
    if !is_enc_string(&wrapped) {
        return Err(ApiError::bad_request("The user key is not encrypted."));
    }
    let auth_hash = require(&master, "masterKeyAuthenticationHash")?;
    let private_key = account_keys(&user, &body)?;
    let data = object(&body, "accountData");

    let contacts = server
        .db
        .bitwarden_emergency_contacts(&user.id, true)
        .await?
        .into_iter()
        .filter(|a| a.status >= emergency_status::CONFIRMED)
        .map(|a| a.id)
        .collect();
    let enrolled = server
        .db
        .bitwarden_memberships(&user.id)
        .await?
        .into_iter()
        .filter(|(m, _)| m.reset_password_key.is_some())
        .map(|(m, _)| m.org_id)
        .collect();
    let rotation = BitwardenKeyRotation {
        ciphers: ciphers(&server, &user, &data).await?,
        folders: folders(&server, &user.id, &data).await?,
        sends: sends(&server, &user.id, &data).await?,
        emergency_keys: keyed(
            items(&unlock, "emergencyAccessUnlockData"),
            "id",
            "keyEncrypted",
            contacts,
            "emergency access keys",
        )?,
        recovery_keys: keyed(
            items(&unlock, "organizationAccountRecoveryUnlockData"),
            "organizationId",
            "resetPasswordKey",
            enrolled,
            "account recovery keys",
        )?,
        credentials: BitwardenCredentials {
            master_password_hash: server.hash_secret(&auth_hash).await?,
            kdf: user.kdf,
            user_key: wrapped,
            security_stamp: new_security_stamp(),
        },
        private_key,
        at: Utc::now(),
    };
    server
        .db
        .bitwarden_rotate_keys(&user.id, &rotation)
        .await
        .map_err(|_| {
            ApiError::bad_request("The rotation names something this account does not own.")
        })?;
    tracing::info!("bitwarden-compat account rotated its user key");
    Ok(StatusCode::OK)
}
