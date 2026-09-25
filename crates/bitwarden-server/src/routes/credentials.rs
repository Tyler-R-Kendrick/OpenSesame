//! Reading new master-password material in both shapes clients send.
//!
//! Older clients send flat members (`kdf`, `kdfIterations`, …,
//! `masterPasswordHash`, `key`). Current clients send an *authentication*
//! object (KDF, salt, the hash the server checks) and an *unlock* object
//! (KDF, salt, the wrapped user key). The two must agree on KDF and salt, and
//! the salt must be the account's email — anything else would leave an
//! account the client can no longer unlock.

use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::kdf::{KdfConfig, KdfPolicy};
use crate::wire::cipher::{is_enc_string, normalize};

/// Member names for one endpoint's body.
pub struct Names {
    pub authentication: &'static str,
    pub unlock: &'static str,
    pub flat_hash: &'static str,
    pub flat_key: &'static str,
}

/// Material to store: the KDF, the hash to check at sign-in, the wrapped key.
pub struct NewCredentials {
    pub kdf: KdfConfig,
    pub auth_hash: String,
    pub wrapped_key: String,
}

pub fn text(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn require(map: &Map<String, Value>, key: &str) -> ApiResult<String> {
    text(map, key).ok_or_else(|| ApiError::bad_request(format!("The {key} field is required.")))
}

fn int(map: &Map<String, Value>, key: &str) -> Option<i64> {
    map.get(key).and_then(Value::as_i64)
}

/// A new KDF passes the policy, unless it is exactly the account's current
/// one: a password change must not strand an older account.
fn admit(
    policy: KdfPolicy,
    current: Option<KdfConfig>,
    raw: [Option<i64>; 4],
) -> ApiResult<KdfConfig> {
    let [kind, iterations, memory, parallelism] = raw;
    let (Some(kind), Some(iterations)) = (kind, iterations) else {
        return current.ok_or_else(|| ApiError::bad_request("The Kdf field is required."));
    };
    let candidate = KdfConfig::validate(kind, iterations, memory, parallelism);
    if let Some(current) = current {
        let unchanged = current.to_stored()
            == opensesame_storage::bitwarden::BitwardenKdf {
                kdf_type: kind,
                iterations,
                memory,
                parallelism,
            };
        if unchanged {
            return Ok(current);
        }
    }
    candidate?;
    policy.admit(kind, iterations, memory, parallelism)
}

fn nested_kdf(object: &Map<String, Value>) -> [Option<i64>; 4] {
    let kdf = normalize(object.get("kdf").cloned().unwrap_or(Value::Null));
    [
        int(&kdf, "kdfType"),
        int(&kdf, "iterations"),
        int(&kdf, "memory"),
        int(&kdf, "parallelism"),
    ]
}

/// Read new credentials for the account `email`. `current` is the account's
/// KDF when it already has one (a password change may omit it).
pub fn read(
    body: &Map<String, Value>,
    names: &Names,
    email: &str,
    policy: KdfPolicy,
    current: Option<KdfConfig>,
) -> ApiResult<NewCredentials> {
    let credentials = match (body.get(names.authentication), body.get(names.unlock)) {
        (Some(auth @ Value::Object(_)), Some(unlock @ Value::Object(_))) => {
            let auth = normalize(auth.clone());
            let unlock = normalize(unlock.clone());
            let (auth_kdf, unlock_kdf) = (nested_kdf(&auth), nested_kdf(&unlock));
            if auth_kdf != unlock_kdf {
                return Err(ApiError::bad_request(
                    "KDF settings must be equal for authentication and unlock.",
                ));
            }
            let salts = [text(&auth, "salt"), text(&unlock, "salt")];
            if salts.iter().any(|salt| salt.as_deref() != Some(email)) {
                return Err(ApiError::bad_request("Invalid master password salt."));
            }
            NewCredentials {
                kdf: admit(policy, current, auth_kdf)?,
                auth_hash: require(&auth, "masterPasswordAuthenticationHash")?,
                wrapped_key: require(&unlock, "masterKeyWrappedUserKey")?,
            }
        }
        _ => NewCredentials {
            kdf: admit(
                policy,
                current,
                [
                    int(body, "kdf"),
                    int(body, "kdfIterations"),
                    int(body, "kdfMemory"),
                    int(body, "kdfParallelism"),
                ],
            )?,
            auth_hash: require(body, names.flat_hash)?,
            wrapped_key: require(body, names.flat_key)?,
        },
    };
    if !is_enc_string(&credentials.wrapped_key) {
        return Err(ApiError::bad_request(
            "The user key is not a valid encrypted string.",
        ));
    }
    Ok(credentials)
}
