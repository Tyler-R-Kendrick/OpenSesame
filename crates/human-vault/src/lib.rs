//! Server-blind E2EE human vault envelopes.
//! Server stores ciphertext only; VRK never leaves the client.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const ENVELOPE_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum VaultCryptoError {
    #[error("aead failure")]
    Aead,
    #[error("kdf failure")]
    Kdf,
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u32),
    #[error("associated data mismatch")]
    AdMismatch,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AssociatedData {
    pub envelope_version: u32,
    pub item_id: String,
    pub organization_id: String,
    pub project_id: String,
    pub collection_id: String,
    pub key_id: String,
    pub revision: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    pub version: u32,
    pub nonce: String,
    pub ciphertext: String,
    pub ad: AssociatedData,
    pub ad_digest: String,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct VaultRootKey(pub [u8; 32]);

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct ItemDataKey(pub [u8; 32]);

impl VaultRootKey {
    pub fn generate() -> Self {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        Self(key)
    }
}

impl ItemDataKey {
    pub fn generate() -> Self {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        Self(key)
    }
}

pub fn ad_digest(ad: &AssociatedData) -> Result<String, VaultCryptoError> {
    let bytes = serde_json::to_vec(ad).map_err(|_| VaultCryptoError::Kdf)?;
    Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

pub fn encrypt_item(
    idk: &ItemDataKey,
    plaintext: &[u8],
    ad: AssociatedData,
) -> Result<EncryptedEnvelope, VaultCryptoError> {
    if ad.envelope_version != ENVELOPE_VERSION {
        return Err(VaultCryptoError::UnsupportedVersion(ad.envelope_version));
    }
    let digest = ad_digest(&ad)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&idk.0).map_err(|_| VaultCryptoError::Aead)?;
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: digest.as_bytes(),
            },
        )
        .map_err(|_| VaultCryptoError::Aead)?;
    Ok(EncryptedEnvelope {
        version: ENVELOPE_VERSION,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ct),
        ad,
        ad_digest: digest,
    })
}

pub fn decrypt_item(
    idk: &ItemDataKey,
    envelope: &EncryptedEnvelope,
) -> Result<Vec<u8>, VaultCryptoError> {
    if envelope.version != ENVELOPE_VERSION {
        return Err(VaultCryptoError::UnsupportedVersion(envelope.version));
    }
    let expected = ad_digest(&envelope.ad)?;
    if expected != envelope.ad_digest {
        return Err(VaultCryptoError::AdMismatch);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(&idk.0).map_err(|_| VaultCryptoError::Aead)?;
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| VaultCryptoError::Aead)?;
    let ct = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| VaultCryptoError::Aead)?;
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: expected.as_bytes(),
            },
        )
        .map_err(|_| VaultCryptoError::Aead)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PasswordWrapper {
    pub salt: String,
    pub params_m_kib: u32,
    pub params_t: u32,
    pub params_p: u32,
    pub wrapped_vrk: String,
    pub nonce: String,
}

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
    let mut kek = [0u8; 32];
    argon
        .hash_password_into(password, &salt, &mut kek)
        .map_err(|_| VaultCryptoError::Kdf)?;
    let kek = hkdf_expand(&kek, b"opensesame/vault/vrk-wrap/v1")?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| VaultCryptoError::Aead)?;
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

pub fn unwrap_vrk_with_password(
    password: &[u8],
    wrapper: &PasswordWrapper,
) -> Result<VaultRootKey, VaultCryptoError> {
    let salt = STANDARD
        .decode(&wrapper.salt)
        .map_err(|_| VaultCryptoError::Kdf)?;
    let params = Params::new(
        wrapper.params_m_kib,
        wrapper.params_t,
        wrapper.params_p,
        Some(32),
    )
    .map_err(|_| VaultCryptoError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = [0u8; 32];
    argon
        .hash_password_into(password, &salt, &mut kek)
        .map_err(|_| VaultCryptoError::Kdf)?;
    let kek = hkdf_expand(&kek, b"opensesame/vault/vrk-wrap/v1")?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| VaultCryptoError::Aead)?;
    let nonce = STANDARD
        .decode(&wrapper.nonce)
        .map_err(|_| VaultCryptoError::Aead)?;
    let wrapped = STANDARD
        .decode(&wrapper.wrapped_vrk)
        .map_err(|_| VaultCryptoError::Aead)?;
    let key = cipher
        .decrypt(XNonce::from_slice(&nonce), wrapped.as_ref())
        .map_err(|_| VaultCryptoError::Aead)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&key);
    Ok(VaultRootKey(out))
}

/// PRF output must never leave the client. Derive KEK with domain separation.
pub fn kek_from_webauthn_prf(
    prf_output: &[u8],
    public_salt: &[u8],
) -> Result<[u8; 32], VaultCryptoError> {
    let hk = Hkdf::<Sha256>::new(Some(public_salt), prf_output);
    let mut out = [0u8; 32];
    hk.expand(b"opensesame/vault/webauthn-prf/v1", &mut out)
        .map_err(|_| VaultCryptoError::Kdf)?;
    Ok(out)
}

fn hkdf_expand(ikm: &[u8], info: &[u8]) -> Result<[u8; 32], VaultCryptoError> {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out)
        .map_err(|_| VaultCryptoError::Kdf)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let idk = ItemDataKey::generate();
        let ad = AssociatedData {
            envelope_version: ENVELOPE_VERSION,
            item_id: "item:1".into(),
            organization_id: "org:1".into(),
            project_id: "project:1".into(),
            collection_id: "col:1".into(),
            key_id: "idk:1".into(),
            revision: 1,
        };
        let env = encrypt_item(&idk, b"super-secret", ad).unwrap();
        let pt = decrypt_item(&idk, &env).unwrap();
        assert_eq!(pt, b"super-secret");
    }

    #[test]
    fn wrong_ad_fails() {
        let idk = ItemDataKey::generate();
        let mut env = encrypt_item(
            &idk,
            b"x",
            AssociatedData {
                envelope_version: ENVELOPE_VERSION,
                item_id: "i".into(),
                organization_id: "o".into(),
                project_id: "p".into(),
                collection_id: "c".into(),
                key_id: "k".into(),
                revision: 1,
            },
        )
        .unwrap();
        env.ad.revision = 2;
        assert!(decrypt_item(&idk, &env).is_err());
    }

    #[test]
    fn password_wrap_roundtrip() {
        let vrk = VaultRootKey::generate();
        let w = wrap_vrk_with_password(b"correct horse battery staple", &vrk).unwrap();
        let unwrapped = unwrap_vrk_with_password(b"correct horse battery staple", &w).unwrap();
        assert_eq!(unwrapped.0, vrk.0);
        assert!(unwrap_vrk_with_password(b"wrong", &w).is_err());
    }

    #[test]
    fn prf_kek_domain_separated() {
        let a = kek_from_webauthn_prf(b"prf-output-32-bytes-long!!!!!!!!", b"salt").unwrap();
        let b = kek_from_webauthn_prf(b"prf-output-32-bytes-long!!!!!!!!", b"salt2").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn truncated_ciphertext_fails() {
        let idk = ItemDataKey::generate();
        let mut env = encrypt_item(
            &idk,
            b"payload",
            AssociatedData {
                envelope_version: ENVELOPE_VERSION,
                item_id: "i".into(),
                organization_id: "o".into(),
                project_id: "p".into(),
                collection_id: "c".into(),
                key_id: "k".into(),
                revision: 1,
            },
        )
        .unwrap();
        env.ciphertext = env.ciphertext.chars().take(8).collect();
        assert!(decrypt_item(&idk, &env).is_err());
    }

    #[test]
    fn wrong_key_fails() {
        let idk = ItemDataKey::generate();
        let other = ItemDataKey::generate();
        let env = encrypt_item(
            &idk,
            b"payload",
            AssociatedData {
                envelope_version: ENVELOPE_VERSION,
                item_id: "i".into(),
                organization_id: "o".into(),
                project_id: "p".into(),
                collection_id: "c".into(),
                key_id: "k".into(),
                revision: 1,
            },
        )
        .unwrap();
        assert!(decrypt_item(&other, &env).is_err());
    }

    #[test]
    fn unsupported_version_rejected() {
        let idk = ItemDataKey::generate();
        let ad = AssociatedData {
            envelope_version: 99,
            item_id: "i".into(),
            organization_id: "o".into(),
            project_id: "p".into(),
            collection_id: "c".into(),
            key_id: "k".into(),
            revision: 1,
        };
        assert!(matches!(
            encrypt_item(&idk, b"x", ad),
            Err(VaultCryptoError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn swapped_item_id_in_ad_fails_decrypt() {
        let idk = ItemDataKey::generate();
        let mut env = encrypt_item(
            &idk,
            b"x",
            AssociatedData {
                envelope_version: ENVELOPE_VERSION,
                item_id: "item-a".into(),
                organization_id: "o".into(),
                project_id: "p".into(),
                collection_id: "c".into(),
                key_id: "k".into(),
                revision: 1,
            },
        )
        .unwrap();
        env.ad.item_id = "item-b".into();
        assert!(decrypt_item(&idk, &env).is_err());
    }

    #[test]
    fn large_plaintext_roundtrip() {
        let idk = ItemDataKey::generate();
        let pt = vec![7u8; 64 * 1024];
        let env = encrypt_item(
            &idk,
            &pt,
            AssociatedData {
                envelope_version: ENVELOPE_VERSION,
                item_id: "big".into(),
                organization_id: "o".into(),
                project_id: "p".into(),
                collection_id: "c".into(),
                key_id: "k".into(),
                revision: 3,
            },
        )
        .unwrap();
        assert_eq!(decrypt_item(&idk, &env).unwrap(), pt);
    }
}
