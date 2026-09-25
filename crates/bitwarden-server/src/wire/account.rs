//! Account-shaped responses: profile, decryption options, token body.

use chrono::{DateTime, Utc};
use opensesame_storage::bitwarden::BitwardenUser;
use serde_json::{json, Value};

use crate::kdf::KdfConfig;

/// Bitwarden's date format: ISO 8601, UTC, fractional seconds.
#[must_use]
pub fn date(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

/// `MasterPasswordUnlock`: what a client needs to derive the master key and
/// unwrap the user key — the KDF, the salt, the wrapped key.
fn master_password_unlock(user: &BitwardenUser) -> Value {
    json!({
        "kdf": KdfConfig::from_stored(user.kdf).settings_json(),
        "masterKeyEncryptedUserKey": user.user_key,
        "salt": user.email,
    })
}

/// The account's key pair in the shape current clients read.
fn account_keys(user: &BitwardenUser) -> Value {
    match (&user.public_key, &user.private_key) {
        (Some(public_key), Some(private_key)) => json!({
            "publicKeyEncryptionKeyPair": {
                "wrappedPrivateKey": private_key,
                "publicKey": public_key,
                "signedPublicKey": null,
                "object": "publicKeyEncryptionKeyPair",
            },
            "signatureKeyPair": null,
            "securityState": null,
            "object": "privateKeys",
        }),
        _ => Value::Null,
    }
}

/// `ProfileResponseModel`.
#[must_use]
pub fn profile(user: &BitwardenUser) -> Value {
    json!({
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "emailVerified": true,
        "premium": true,
        "premiumFromOrganization": false,
        "masterPasswordHint": user.master_password_hint,
        "culture": user.culture,
        "twoFactorEnabled": false,
        "key": user.user_key,
        "privateKey": user.private_key,
        "accountKeys": account_keys(user),
        "securityStamp": user.security_stamp,
        "forcePasswordReset": false,
        "usesKeyConnector": false,
        "avatarColor": null,
        "creationDate": date(user.created_at),
        "verifyDevices": false,
        "organizations": [],
        "providers": [],
        "providerOrganizations": [],
        "object": "profile",
    })
}

/// `UserDecryptionResponseModel`, as `/sync` carries it.
#[must_use]
pub fn sync_decryption(user: &BitwardenUser) -> Value {
    json!({
        "masterPasswordUnlock": master_password_unlock(user),
        "userKeyId": user.user_key_id,
    })
}

/// The body of a successful `/identity/connect/token` exchange.
#[must_use]
pub fn token_body(
    user: &BitwardenUser,
    access_token: &str,
    expires_in: i64,
    refresh_token: &str,
) -> Value {
    let kdf = KdfConfig::from_stored(user.kdf);
    let mut body = json!({
        "access_token": access_token,
        "expires_in": expires_in,
        "token_type": "Bearer",
        "refresh_token": refresh_token,
        "scope": "api offline_access",
        "Key": user.user_key,
        "PrivateKey": user.private_key,
        "AccountKeys": account_keys(user),
        "ResetMasterPassword": false,
        "ForcePasswordReset": false,
        "MasterPasswordPolicy": { "Object": "masterPasswordPolicy" },
        "UserDecryptionOptions": {
            "HasMasterPassword": true,
            "MasterPasswordUnlock": {
                "Kdf": {
                    "KdfType": kdf.kdf_type as i64,
                    "Iterations": kdf.iterations,
                    "Memory": kdf.memory_mib,
                    "Parallelism": kdf.parallelism,
                },
                "MasterKeyEncryptedUserKey": user.user_key,
                "Salt": user.email,
            },
            "Object": "userDecryptionOptions",
        },
    });
    // The flat `Kdf*` members older clients read beside the options.
    if let (Some(target), Value::Object(flat)) = (body.as_object_mut(), kdf.flat_json()) {
        for (key, value) in flat {
            let mut chars = key.chars();
            let pascal = chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default();
            target.insert(pascal, value);
        }
    }
    body
}
