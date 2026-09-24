//! Unwrapping the vault key (vault-format-v1 §2, §4, §5): the master
//! password or PIN through NFKC and PBKDF2-HMAC-SHA-256, a passkey PRF output
//! through HKDF-SHA-256, then AES-256-GCM over the wrap with no additional
//! data. Every intermediate key and the normalised secret are zeroized; none
//! is written anywhere.

use std::fmt;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::{
    error::{Result, VaultFileError},
    header::{PasskeyRecord, SealedBlob, ValidKdf, VaultHeader},
    pin,
};

const KEY_BYTES: usize = 32;

/// VK, the vault key (§2). Zeroized on drop; its bytes never leave this
/// module, and its `Debug` prints nothing of them.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct VaultKey([u8; KEY_BYTES]);

impl VaultKey {
    pub(super) fn bytes(&self) -> &[u8; KEY_BYTES] {
        &self.0
    }
}

impl fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VaultKey(<redacted>)")
    }
}

/// Open one AES-256-GCM seal; `None` on a tag failure. An absent `WebCrypto`
/// `additionalData` is the empty one.
pub(super) fn open_seal(
    key: &[u8; KEY_BYTES],
    blob: &SealedBlob,
    aad: &[u8],
) -> Option<Zeroizing<Vec<u8>>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&blob.iv), Payload { msg: &blob.ct, aad })
        .ok()
        .map(Zeroizing::new)
}

/// MK or the PIN KEK: PBKDF2-HMAC-SHA-256 over the NFKC form (§2).
fn derive_kek(secret: &str, kdf: &ValidKdf) -> Zeroizing<[u8; KEY_BYTES]> {
    let normalized: Zeroizing<String> = Zeroizing::new(secret.nfkc().collect());
    let mut kek = Zeroizing::new([0u8; KEY_BYTES]);
    pbkdf2::pbkdf2_hmac::<Sha256>(
        normalized.as_bytes(),
        &kdf.salt,
        kdf.iterations,
        kek.as_mut(),
    );
    kek
}

/// A tag failure on a wrap is the wrong credential, and the only way one is
/// detected (§4).
fn unwrap_vault_key(kek: &[u8; KEY_BYTES], wrap: &SealedBlob) -> Result<VaultKey> {
    let raw = open_seal(kek, wrap, &[]).ok_or(VaultFileError::WrongPassword)?;
    if raw.len() != KEY_BYTES {
        return Err(VaultFileError::Corrupt(
            "the unwrapped vault key is not 32 bytes",
        ));
    }
    let mut vault_key = VaultKey([0; KEY_BYTES]);
    vault_key.0.copy_from_slice(&raw);
    Ok(vault_key)
}

/// Unwrap VK with the master password (§4). The KDF is validated before
/// anything is derived.
///
/// # Errors
///
/// `Corrupt` for a header with no password wrap or an altered KDF,
/// `WrongPassword` when the wrap's tag fails.
pub fn unwrap_with_password(header: &VaultHeader, password: &str) -> Result<VaultKey> {
    let (kdf, wrap) = header.password_wrap()?;
    let kek = derive_kek(password, &kdf);
    unwrap_vault_key(&kek, &wrap)
}

/// Unwrap VK with the device PIN (§5). The PIN policy and the KDF are checked
/// before anything is derived.
///
/// # Errors
///
/// `Rejected` for a PIN the policy refuses, `Corrupt` for a header with no
/// PIN wrap or an altered KDF, `WrongPassword` when the wrap's tag fails.
pub fn unwrap_with_pin(header: &VaultHeader, pin: &str) -> Result<VaultKey> {
    pin::check_policy(pin)?;
    let (kdf, wrap) = header.pin_wrap()?;
    let kek = derive_kek(pin, &kdf);
    unwrap_vault_key(&kek, &wrap)
}

/// Unwrap VK with a passkey's `WebAuthn` PRF output (§5):
/// `HKDF-SHA-256(ikm = PRF output, salt = prfSalt,
/// info = "opensesame/vault/webauthn-prf/v1")`, as `kek_from_webauthn_prf`.
///
/// # Errors
///
/// `WrongPassword` when the wrap's tag fails.
pub fn unwrap_with_prf(record: &PasskeyRecord, prf_output: &[u8]) -> Result<VaultKey> {
    let kek = Zeroizing::new(
        crate::kek_from_webauthn_prf(prf_output, &record.prf_salt)
            .map_err(|_| VaultFileError::Corrupt("the passkey key derivation failed"))?,
    );
    unwrap_vault_key(&kek, &record.wrap)
}
