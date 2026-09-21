//! Recovery-key protector wrap helpers.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{hkdf_expand, VaultRootKey};

use super::error::ProtectionError;
use super::limits::DOMAIN_RECOVERY_WRAP;
use super::types::RecoveryWrap;

/// Wrap `vrk` under a high-entropy recovery secret.
///
/// # Errors
///
/// Returns crypto failures when AEAD or KDF fails.
pub fn wrap_vrk_with_recovery_key(
    recovery_key: &[u8; 32],
    vrk: &VaultRootKey,
) -> Result<(RecoveryWrap, String), ProtectionError> {
    let mut kek = hkdf_expand(recovery_key, DOMAIN_RECOVERY_WRAP)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| ProtectionError::Crypto)?;
    kek.zeroize();
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), vrk.0.as_ref())
        .map_err(|_| ProtectionError::Crypto)?;
    let fingerprint = fingerprint_recovery_key(recovery_key);
    Ok((
        RecoveryWrap {
            nonce_b64: URL_SAFE_NO_PAD.encode(nonce),
            ct_b64: URL_SAFE_NO_PAD.encode(ct),
        },
        fingerprint,
    ))
}

/// Unwrap a recovery wrap.
///
/// # Errors
///
/// Returns `CapsuleAuthFailed` when the recovery key does not open the wrap.
pub fn unwrap_vrk_with_recovery_key(
    recovery_key: &[u8; 32],
    wrap: &RecoveryWrap,
) -> Result<VaultRootKey, ProtectionError> {
    let mut kek = hkdf_expand(recovery_key, DOMAIN_RECOVERY_WRAP)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| ProtectionError::Crypto)?;
    kek.zeroize();
    let nonce = URL_SAFE_NO_PAD
        .decode(&wrap.nonce_b64)
        .map_err(|_| ProtectionError::MalformedEncoding("recovery nonce".into()))?;
    if nonce.len() != 24 {
        return Err(ProtectionError::MalformedEncoding(
            "recovery nonce length".into(),
        ));
    }
    let ct = URL_SAFE_NO_PAD
        .decode(&wrap.ct_b64)
        .map_err(|_| ProtectionError::MalformedEncoding("recovery ciphertext".into()))?;
    let mut pt = cipher
        .decrypt(XNonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| ProtectionError::CapsuleAuthFailed)?;
    if pt.len() != 32 {
        pt.zeroize();
        return Err(ProtectionError::InvalidKeyLength);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&pt);
    pt.zeroize();
    Ok(VaultRootKey(out))
}

#[must_use]
pub fn fingerprint_recovery_key(recovery_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(recovery_key);
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

/// Generate a fresh 32-byte recovery secret.
#[must_use]
pub fn generate_recovery_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    key
}
