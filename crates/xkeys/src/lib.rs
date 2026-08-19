//! X25519 recipient keys + AEAD for E2EE bus / callout payloads.
//!
//! **Hard rule:** this crate must never use the Host connection seal key /
//! deployment seal key, or any broker credential wrapping key. Bus E2EE is
//! client-held X25519 material only (ADR 0042).

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Wire format version byte for sealed blobs.
pub const SEAL_VERSION: u8 = 1;

const HKDF_INFO: &[u8] = b"opensesame-xkeys-v1";
const NONCE_LEN: usize = 24;
const PK_LEN: usize = 32;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum XkeysError {
    #[error("aead failure")]
    Aead,
    #[error("kdf failure")]
    Kdf,
    #[error("unsupported seal version {0}")]
    UnsupportedVersion(u8),
    #[error("ciphertext too short")]
    Truncated,
    #[error("invalid public key length")]
    PublicKeyLength,
}

/// Recipient / identity X25519 keypair. Secret half is zeroized on drop.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct XKeyPair {
    secret: [u8; 32],
    #[zeroize(skip)]
    public: [u8; 32],
}

impl XKeyPair {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&secret);
        Self {
            secret: secret.to_bytes(),
            public: *public.as_bytes(),
        }
    }

    pub fn from_secret_bytes(secret: [u8; 32]) -> Self {
        let sk = StaticSecret::from(secret);
        let public = PublicKey::from(&sk);
        Self {
            secret,
            public: *public.as_bytes(),
        }
    }

    pub fn public_bytes(&self) -> [u8; 32] {
        self.public
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey::from(self.public)
    }

    fn secret(&self) -> StaticSecret {
        StaticSecret::from(self.secret)
    }
}

/// Seal `plaintext` to `recipient` public key.
///
/// Output layout: `version (1) || ephemeral_pk (32) || nonce (24) || ciphertext+tag`.
///
/// Uses an ephemeral X25519 keypair + HKDF-SHA256 → XChaCha20-Poly1305. Does
/// **not** consult any Host deployment / connection sealing key.
pub fn seal(plaintext: &[u8], recipient: &PublicKey) -> Result<Vec<u8>, XkeysError> {
    let eph_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let eph_public = PublicKey::from(&eph_secret);
    let shared = eph_secret.diffie_hellman(recipient);
    let key = derive_aead_key(shared.as_bytes(), eph_public.as_bytes(), recipient.as_bytes())?;

    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);

    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| XkeysError::Kdf)?;
    let ad = associated_data(eph_public.as_bytes(), recipient.as_bytes());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &ad,
            },
        )
        .map_err(|_| XkeysError::Aead)?;

    let mut out = Vec::with_capacity(1 + PK_LEN + NONCE_LEN + ciphertext.len());
    out.push(SEAL_VERSION);
    out.extend_from_slice(eph_public.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a blob produced by [`seal`] with the recipient's private keypair.
pub fn open(sealed: &[u8], recipient: &XKeyPair) -> Result<Vec<u8>, XkeysError> {
    if sealed.len() < 1 + PK_LEN + NONCE_LEN + 16 {
        return Err(XkeysError::Truncated);
    }
    let version = sealed[0];
    if version != SEAL_VERSION {
        return Err(XkeysError::UnsupportedVersion(version));
    }
    let eph_pk_bytes: [u8; 32] = sealed[1..1 + PK_LEN]
        .try_into()
        .map_err(|_| XkeysError::PublicKeyLength)?;
    let eph_public = PublicKey::from(eph_pk_bytes);
    let nonce = &sealed[1 + PK_LEN..1 + PK_LEN + NONCE_LEN];
    let ciphertext = &sealed[1 + PK_LEN + NONCE_LEN..];

    let shared = recipient.secret().diffie_hellman(&eph_public);
    let recipient_pk = recipient.public_bytes();
    let key = derive_aead_key(shared.as_bytes(), eph_public.as_bytes(), &recipient_pk)?;

    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| XkeysError::Kdf)?;
    let ad = associated_data(eph_public.as_bytes(), &recipient_pk);
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &ad,
            },
        )
        .map_err(|_| XkeysError::Aead)
}

fn derive_aead_key(
    shared: &[u8],
    ephemeral_pk: &[u8],
    recipient_pk: &[u8],
) -> Result<[u8; 32], XkeysError> {
    let mut salt = [0u8; PK_LEN * 2];
    salt[..PK_LEN].copy_from_slice(ephemeral_pk);
    salt[PK_LEN..].copy_from_slice(recipient_pk);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .map_err(|_| XkeysError::Kdf)?;
    Ok(okm)
}

fn associated_data(ephemeral_pk: &[u8], recipient_pk: &[u8]) -> Vec<u8> {
    let mut ad = Vec::with_capacity(HKDF_INFO.len() + PK_LEN * 2);
    ad.extend_from_slice(HKDF_INFO);
    ad.extend_from_slice(ephemeral_pk);
    ad.extend_from_slice(recipient_pk);
    ad
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_seal_open() {
        let alice = XKeyPair::generate();
        let sealed = seal(b"nats-e2ee-payload", &alice.public_key()).expect("seal");
        let opened = open(&sealed, &alice).expect("open");
        assert_eq!(opened, b"nats-e2ee-payload");
    }

    #[test]
    fn wrong_recipient_cannot_open() {
        let alice = XKeyPair::generate();
        let bob = XKeyPair::generate();
        let sealed = seal(b"secret", &alice.public_key()).unwrap();
        assert_eq!(open(&sealed, &bob), Err(XkeysError::Aead));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let kp = XKeyPair::generate();
        let mut sealed = seal(b"hello", &kp.public_key()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert_eq!(open(&sealed, &kp), Err(XkeysError::Aead));
    }

    #[test]
    fn seal_does_not_embed_connection_key_marker() {
        // Scan production source only — this test string must not poison the check.
        let src = include_str!("lib.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !code.contains("std::env") && !code.contains("ENV_CONNECTION"),
            "xkeys production code must not load Host connection/deployment seal material"
        );
    }

    #[test]
    fn from_secret_bytes_stable_public() {
        let secret = [7u8; 32];
        let a = XKeyPair::from_secret_bytes(secret);
        let b = XKeyPair::from_secret_bytes(secret);
        assert_eq!(a.public_bytes(), b.public_bytes());
        let sealed = seal(b"stable", &a.public_key()).unwrap();
        assert_eq!(open(&sealed, &b).unwrap(), b"stable");
    }
}

#[cfg(test)]
mod pact {
    use super::*;

    #[test]
    fn property_seal_open_round_trips_many_payloads() {
        let kp = XKeyPair::generate();
        for payload in [b"" as &[u8], b"x", b"nats-e2ee-payload", &[7u8; 1024]] {
            let sealed = seal(payload, &kp.public_key()).unwrap();
            assert_eq!(open(&sealed, &kp).unwrap(), payload);
        }
    }

    #[test]
    fn adversarial_wrong_recipient_and_truncation_fail_closed() {
        let alice = XKeyPair::generate();
        let bob = XKeyPair::generate();
        let sealed = seal(b"secret", &alice.public_key()).unwrap();
        assert_eq!(open(&sealed, &bob), Err(XkeysError::Aead));
        assert_eq!(open(&sealed[..8], &alice), Err(XkeysError::Truncated));
    }

    #[test]
    fn chaos_tamper_never_opens() {
        let kp = XKeyPair::generate();
        let sealed = seal(b"hello", &kp.public_key()).unwrap();
        for i in [0usize, sealed.len() / 2, sealed.len() - 1] {
            let mut hostile = sealed.clone();
            hostile[i] ^= 0xff;
            assert!(open(&hostile, &kp).is_err());
        }
    }

    #[test]
    fn contract_production_source_does_not_load_host_seal_env() {
        let src = include_str!("lib.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(!code.contains("std::env") && !code.contains("ENV_CONNECTION"));
        let sealed = seal(b"secret-item", &XKeyPair::generate().public_key()).unwrap();
        let json = String::from_utf8_lossy(&sealed);
        assert!(!json.contains("secret-item"));
    }
}
