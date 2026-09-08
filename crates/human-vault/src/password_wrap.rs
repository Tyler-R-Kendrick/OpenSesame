use crate::{decode_nonce, hkdf_expand, kdf_policy, VaultCryptoError, VaultRootKey};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Clone, Serialize, Deserialize)]
pub struct PasswordWrapper {
    pub salt: String,
    pub params_m_kib: u32,
    pub params_t: u32,
    pub params_p: u32,
    pub wrapped_vrk: String,
    pub nonce: String,
}

///
/// # Errors
///
/// Returns an error when key derivation or authenticated encryption fails.
pub fn wrap_vrk_with_password(
    password: &[u8],
    vrk: &VaultRootKey,
) -> Result<PasswordWrapper, VaultCryptoError> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let m_kib = 64 * 1024;
    let t = 3;
    let p = 1;
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|_| VaultCryptoError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut ikm = [0u8; 32];
    argon
        .hash_password_into(password, &salt, &mut ikm)
        .map_err(|_| VaultCryptoError::Kdf)?;
    let mut kek = hkdf_expand(&ikm, b"opensesame/vault/vrk-wrap/v1")?;
    ikm.zeroize();
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| VaultCryptoError::Aead)?;
    // The unwrap path already cleans both of these up; wrapping left the Argon2
    // output and the KEK sitting in this frame for no reason.
    kek.zeroize();
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let wrapped = cipher
        .encrypt(XNonce::from_slice(&nonce), vrk.0.as_ref())
        .map_err(|_| VaultCryptoError::Aead)?;
    Ok(PasswordWrapper {
        salt: STANDARD.encode(salt),
        params_m_kib: m_kib,
        params_t: t,
        params_p: p,
        wrapped_vrk: STANDARD.encode(wrapped),
        nonce: STANDARD.encode(nonce),
    })
}

/// Refuse KDF parameters outside the accepted band.
///
/// # Errors
///
/// Returns `KdfParamsOutOfRange` when any parameter is outside the accepted
/// work band.
pub fn assert_argon_params_accepted(m_kib: u32, t: u32, p: u32) -> Result<(), VaultCryptoError> {
    kdf_policy::KdfPolicy::current_platform()
        .inspect(m_kib, t, p)
        .map(|_| ())
}

///
/// # Errors
///
/// Returns an error for unsafe KDF parameters, malformed wrapper data,
/// authentication failure, or an invalid root-key length.
pub fn unwrap_vrk_with_password(
    password: &[u8],
    wrapper: &PasswordWrapper,
) -> Result<VaultRootKey, VaultCryptoError> {
    assert_argon_params_accepted(wrapper.params_m_kib, wrapper.params_t, wrapper.params_p)?;
    unwrap_admitted(password, wrapper)
}

/// Rewrap a legacy password wrapper under the portable writer policy. The key
/// never leaves this operation. Use only in an offline native migration command.
///
/// # Errors
/// Refuses unapproved work, malformed metadata, or an incorrect password.
#[cfg(not(target_arch = "wasm32"))]
pub fn migrate_password_wrapper_offline(
    password: &[u8],
    wrapper: &PasswordWrapper,
    budget: &kdf_policy::OfflineMigrationBudget,
) -> Result<PasswordWrapper, VaultCryptoError> {
    budget.admit(wrapper.params_m_kib, wrapper.params_t, wrapper.params_p)?;
    let vrk = unwrap_admitted(password, wrapper)?;
    wrap_vrk_with_password(password, &vrk)
}

fn unwrap_admitted(
    password: &[u8],
    wrapper: &PasswordWrapper,
) -> Result<VaultRootKey, VaultCryptoError> {
    // Bound encoded fields and validate their shapes before expensive Argon2.
    if wrapper.salt.len() != 24 {
        return Err(VaultCryptoError::Kdf);
    }
    if wrapper.nonce.len() != 32 {
        return Err(VaultCryptoError::NonceLength);
    }
    if wrapper.wrapped_vrk.len() != 64 {
        return Err(VaultCryptoError::KeyLength);
    }
    let salt = STANDARD
        .decode(&wrapper.salt)
        .map_err(|_| VaultCryptoError::Kdf)?;
    if salt.len() != 16 {
        return Err(VaultCryptoError::Kdf);
    }
    let nonce = decode_nonce(&wrapper.nonce)?;
    let wrapped_bytes = STANDARD
        .decode(&wrapper.wrapped_vrk)
        .map_err(|_| VaultCryptoError::Aead)?;
    if wrapped_bytes.len() != 48 {
        return Err(VaultCryptoError::KeyLength);
    }
    let params = Params::new(
        wrapper.params_m_kib,
        wrapper.params_t,
        wrapper.params_p,
        Some(32),
    )
    .map_err(|_| VaultCryptoError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut ikm = [0u8; 32];
    argon
        .hash_password_into(password, &salt, &mut ikm)
        .map_err(|_| VaultCryptoError::Kdf)?;
    let mut wrapping_key = hkdf_expand(&ikm, b"opensesame/vault/vrk-wrap/v1")?;
    ikm.zeroize();
    let cipher =
        XChaCha20Poly1305::new_from_slice(&wrapping_key).map_err(|_| VaultCryptoError::Aead)?;
    wrapping_key.zeroize();
    let mut plaintext_vrk = cipher
        .decrypt(XNonce::from_slice(&nonce), wrapped_bytes.as_ref())
        .map_err(|_| VaultCryptoError::Aead)?;
    // Authentic but wrong-sized material must be an error, not a panic on
    // `copy_from_slice`.
    if plaintext_vrk.len() != 32 {
        plaintext_vrk.zeroize();
        return Err(VaultCryptoError::KeyLength);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&plaintext_vrk);
    plaintext_vrk.zeroize();
    Ok(VaultRootKey(out))
}
