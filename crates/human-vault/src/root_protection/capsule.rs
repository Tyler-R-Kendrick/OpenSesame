//! Root capsule: context-bound AES-GCM of the 32-byte vault root.
//! Mutable manifest revision is NEVER in capsule AAD (C04).
//! Encoding matches apps/pages protection/capsule.ts.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroize;

use super::canonicalize::canonicalize_to_bytes;
use super::error::ProtectionError;
use super::limits::{DOMAIN_CAPSULE, ROOT_KEY_BYTES};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionContext {
    pub vault_id: String,
    pub root_key_id: String,
    pub root_epoch: u64,
    pub protector_id: String,
    pub purpose: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedBlobV1 {
    pub iv_b64: String,
    pub ct_b64: String,
}

fn context_aad(context: &ProtectionContext) -> Result<Vec<u8>, ProtectionError> {
    let value = json!({
        "domain": std::str::from_utf8(DOMAIN_CAPSULE).map_err(|_| ProtectionError::Crypto)?,
        "context": {
            "vaultId": context.vault_id,
            "rootKeyId": context.root_key_id,
            "rootEpoch": context.root_epoch,
            "protectorId": context.protector_id,
            "purpose": context.purpose,
        }
    });
    canonicalize_to_bytes(&value)
}

fn plaintext_bytes(
    context: &ProtectionContext,
    root_key: &[u8],
) -> Result<Vec<u8>, ProtectionError> {
    let value = json!({
        "v": 1,
        "domain": std::str::from_utf8(DOMAIN_CAPSULE).map_err(|_| ProtectionError::Crypto)?,
        "context": {
            "vaultId": context.vault_id,
            "rootKeyId": context.root_key_id,
            "rootEpoch": context.root_epoch,
            "protectorId": context.protector_id,
            "purpose": context.purpose,
        },
        "rootKeyB64": STANDARD.encode(root_key),
    });
    canonicalize_to_bytes(&value)
}

/// Seal a 32-byte root under `kek` with context AAD.
///
/// # Errors
///
/// Returns typed failures for length, encoding, or AEAD errors.
pub fn seal_root_capsule(
    kek: &[u8; 32],
    context: &ProtectionContext,
    root_key: &[u8],
    iv: &[u8; 12],
) -> Result<SealedBlobV1, ProtectionError> {
    if root_key.len() != ROOT_KEY_BYTES {
        return Err(ProtectionError::InvalidKeyLength);
    }
    let aad = context_aad(context)?;
    let mut pt = plaintext_bytes(context, root_key)?;
    let cipher = Aes256Gcm::new_from_slice(kek).map_err(|_| ProtectionError::Crypto)?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: &pt,
                aad: &aad,
            },
        )
        .map_err(|_| ProtectionError::Crypto)?;
    pt.zeroize();
    Ok(SealedBlobV1 {
        iv_b64: STANDARD.encode(iv),
        ct_b64: STANDARD.encode(ct),
    })
}

/// Open a sealed capsule, requiring the independently chosen context.
///
/// # Errors
///
/// Returns typed failures for nonce, AEAD, context, or key length.
pub fn open_root_capsule(
    kek: &[u8; 32],
    expected: &ProtectionContext,
    sealed: &SealedBlobV1,
) -> Result<[u8; 32], ProtectionError> {
    let iv = STANDARD
        .decode(&sealed.iv_b64)
        .map_err(|_| ProtectionError::MalformedEncoding("capsule iv".into()))?;
    if iv.len() != 12 {
        return Err(ProtectionError::MalformedEncoding(
            "capsule iv length".into(),
        ));
    }
    let ct = STANDARD
        .decode(&sealed.ct_b64)
        .map_err(|_| ProtectionError::MalformedEncoding("capsule ct".into()))?;
    let aad = context_aad(expected)?;
    let cipher = Aes256Gcm::new_from_slice(kek).map_err(|_| ProtectionError::Crypto)?;
    let raw = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ct,
                aad: &aad,
            },
        )
        .map_err(|_| ProtectionError::CapsuleAuthFailed)?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?;
    let v = value
        .get("v")
        .and_then(Value::as_u64)
        .ok_or(ProtectionError::UnsupportedVersion(0))?;
    if v != 1 {
        return Err(ProtectionError::UnsupportedVersion(v as u32));
    }
    let domain = value
        .get("domain")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtectionError::MalformedEncoding("domain".into()))?;
    if domain.as_bytes() != DOMAIN_CAPSULE {
        return Err(ProtectionError::UnsupportedVersion(0));
    }
    let ctx = value
        .get("context")
        .ok_or_else(|| ProtectionError::MalformedEncoding("context".into()))?;
    let parsed = ProtectionContext {
        vault_id: ctx
            .get("vaultId")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtectionError::MalformedEncoding("vaultId".into()))?
            .to_string(),
        root_key_id: ctx
            .get("rootKeyId")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtectionError::MalformedEncoding("rootKeyId".into()))?
            .to_string(),
        root_epoch: ctx
            .get("rootEpoch")
            .and_then(Value::as_u64)
            .ok_or_else(|| ProtectionError::MalformedEncoding("rootEpoch".into()))?,
        protector_id: ctx
            .get("protectorId")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtectionError::MalformedEncoding("protectorId".into()))?
            .to_string(),
        purpose: ctx
            .get("purpose")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtectionError::MalformedEncoding("purpose".into()))?
            .to_string(),
    };
    if &parsed != expected {
        return Err(ProtectionError::ContextMismatch);
    }
    let root_b64 = value
        .get("rootKeyB64")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtectionError::MalformedEncoding("rootKeyB64".into()))?;
    let root = STANDARD
        .decode(root_b64)
        .map_err(|_| ProtectionError::InvalidKeyLength)?;
    let key: [u8; 32] = root
        .try_into()
        .map_err(|_| ProtectionError::InvalidKeyLength)?;
    Ok(key)
}
