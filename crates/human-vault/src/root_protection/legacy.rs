//! Legacy `.opensesame-key` password-wrapper readers (KP-03).

use serde_json::Value;

use crate::password_wrap::{unwrap_vrk_with_password, PasswordWrapper};
use crate::VaultRootKey;

use super::error::ProtectionError;

/// True when the JSON object looks like a bare legacy password wrapper.
#[must_use]
pub fn looks_like_legacy_password_wrapper(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if obj.contains_key("schemaVersion") || obj.contains_key("schema_version") {
        return false;
    }
    obj.contains_key("salt")
        && obj.contains_key("wrapped_vrk")
        && obj.contains_key("nonce")
        && obj.contains_key("params_m_kib")
}

/// Parse a legacy password wrapper with precise structural errors.
///
/// # Errors
///
/// Returns `MalformedLegacy` when required fields are missing or mistyped.
pub fn parse_legacy_password_wrapper(json: &str) -> Result<PasswordWrapper, ProtectionError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| ProtectionError::MalformedLegacy(format!("json: {e}")))?;
    if !looks_like_legacy_password_wrapper(&value) {
        return Err(ProtectionError::MalformedLegacy(
            "not a legacy password wrapper".into(),
        ));
    }
    let obj = value
        .as_object()
        .ok_or_else(|| ProtectionError::MalformedLegacy("expected object".into()))?;
    for required in [
        "salt",
        "params_m_kib",
        "params_t",
        "params_p",
        "wrapped_vrk",
        "nonce",
    ] {
        if !obj.contains_key(required) {
            return Err(ProtectionError::MalformedLegacy(format!(
                "missing field {required}"
            )));
        }
    }
    serde_json::from_value(value)
        .map_err(|e| ProtectionError::MalformedLegacy(format!("decode: {e}")))
}

/// Unwrap a legacy wrapper under `password`.
///
/// # Errors
///
/// Propagates KDF bounds and crypto failures from the password unwrap path.
pub fn unlock_legacy_password_wrapper(
    password: &[u8],
    wrapper: &PasswordWrapper,
) -> Result<VaultRootKey, ProtectionError> {
    Ok(unwrap_vrk_with_password(password, wrapper)?)
}
