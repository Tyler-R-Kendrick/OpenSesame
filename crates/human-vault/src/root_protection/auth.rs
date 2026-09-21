//! Manifest authentication (root-derived HMAC over canonical bytes).
//! Must match apps/pages protection/manifest-auth.ts (HMAC-SHA256 + std base64).

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::{hkdf_expand, VaultRootKey};

use super::canonicalize::canonicalize_to_bytes;
use super::error::ProtectionError;
use super::limits::DOMAIN_MANIFEST_MAC;
use super::types::RootProtectionManifest;

type HmacSha256 = Hmac<Sha256>;

/// Authenticate `manifest` in place using a root-derived MAC key.
///
/// # Errors
///
/// Returns an error when serialization or key derivation fails.
pub fn seal_manifest_auth(
    vrk: &VaultRootKey,
    manifest: &mut RootProtectionManifest,
) -> Result<(), ProtectionError> {
    manifest.auth_b64 = None;
    let tag = compute_auth_tag(vrk, manifest)?;
    manifest.auth_b64 = Some(STANDARD.encode(tag));
    Ok(())
}

/// Verify `manifest.auth_b64` against the root key.
///
/// # Errors
///
/// Returns `ManifestAuthFailed` when the tag is missing or wrong.
pub fn verify_manifest_auth(
    vrk: &VaultRootKey,
    manifest: &RootProtectionManifest,
) -> Result<(), ProtectionError> {
    let Some(presented) = manifest.auth_b64.as_deref() else {
        return Err(ProtectionError::ManifestAuthFailed);
    };
    let expected = compute_auth_tag(vrk, manifest)?;
    let Ok(got) = STANDARD.decode(presented) else {
        return Err(ProtectionError::ManifestAuthFailed);
    };
    if got.len() != expected.len() {
        return Err(ProtectionError::ManifestAuthFailed);
    }
    let mut ok = 0u8;
    for (a, b) in got.iter().zip(expected.iter()) {
        ok |= a ^ b;
    }
    if ok != 0 {
        return Err(ProtectionError::ManifestAuthFailed);
    }
    Ok(())
}

fn compute_auth_tag(
    vrk: &VaultRootKey,
    manifest: &RootProtectionManifest,
) -> Result<[u8; 32], ProtectionError> {
    let mut for_mac = manifest.clone();
    for_mac.auth_b64 = None;
    let value = serde_json::to_value(&for_mac)
        .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?;
    let value = strip_nulls(value);
    let bytes = canonicalize_to_bytes(&value)?;
    let mut mac_key = hkdf_expand(&vrk.0, DOMAIN_MANIFEST_MAC)?;
    let mut mac = HmacSha256::new_from_slice(&mac_key).map_err(|_| ProtectionError::Crypto)?;
    mac_key.zeroize();
    mac.update(&bytes);
    let result = mac.finalize().into_bytes();
    let mut tag = [0u8; 32];
    tag.copy_from_slice(&result);
    Ok(tag)
}

fn strip_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if v.is_null() {
                    continue;
                }
                out.insert(k, strip_nulls(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(strip_nulls).collect()),
        other => other,
    }
}
