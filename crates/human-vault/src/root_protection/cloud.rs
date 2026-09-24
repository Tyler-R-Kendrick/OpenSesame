//! Shared cloud wrapping-secret envelope (C05). Matches TS cloud-envelope.ts.

use rand::RngCore;
use zeroize::Zeroize;

use crate::hkdf_expand;

use super::capsule::{open_root_capsule, seal_root_capsule, ProtectionContext, SealedBlobV1};
use super::error::ProtectionError;
use super::limits::{DOMAIN_CLOUD_WRAP, ROOT_KEY_BYTES, WRAPPING_SECRET_BYTES};

pub struct CloudLocalEnvelope {
    pub wrapping_secret: [u8; 32],
    pub local_capsule: SealedBlobV1,
}

/// Derive the local AES-GCM KEK from a 32-byte wrapping secret.
///
/// # Errors
///
/// Returns `InvalidKeyLength` or `Crypto` on HKDF failure.
pub fn derive_local_kek(wrapping_secret: &[u8]) -> Result<[u8; 32], ProtectionError> {
    if wrapping_secret.len() != WRAPPING_SECRET_BYTES {
        return Err(ProtectionError::InvalidKeyLength);
    }
    Ok(hkdf_expand(wrapping_secret, DOMAIN_CLOUD_WRAP)?)
}

/// Create a cloud local envelope (caller encrypts `wrapping_secret` with KMS).
///
/// # Errors
///
/// Returns typed crypto/length errors.
pub fn create_cloud_local_envelope(
    context: &ProtectionContext,
    root_key: &[u8],
) -> Result<CloudLocalEnvelope, ProtectionError> {
    if root_key.len() != ROOT_KEY_BYTES {
        return Err(ProtectionError::InvalidKeyLength);
    }
    let mut wrapping_secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut wrapping_secret);
    let kek = derive_local_kek(&wrapping_secret)?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let local_capsule = seal_root_capsule(&kek, context, root_key, &iv)?;
    Ok(CloudLocalEnvelope {
        wrapping_secret,
        local_capsule,
    })
}

/// Open a cloud local envelope after KMS returns the wrapping secret.
///
/// # Errors
///
/// Returns typed crypto/context errors.
pub fn open_cloud_local_envelope(
    context: &ProtectionContext,
    wrapping_secret: &[u8],
    local_capsule: &SealedBlobV1,
) -> Result<[u8; 32], ProtectionError> {
    let kek = derive_local_kek(wrapping_secret)?;
    open_root_capsule(&kek, context, local_capsule)
}

impl Drop for CloudLocalEnvelope {
    fn drop(&mut self) {
        self.wrapping_secret.zeroize();
    }
}
