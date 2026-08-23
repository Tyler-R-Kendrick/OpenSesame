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

#[cfg(test)]
mod chunk_tests;

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
    /// The stored wrapper asked for KDF work outside the accepted band. The
    /// wrapper travels through a server we do not trust, so its parameters are
    /// untrusted input: too little work weakens the wrap, too much is a way to
    /// exhaust the client's memory.
    #[error("password wrapper KDF parameters out of range")]
    KdfParamsOutOfRange,
    /// Unwrapped material was not a 32-byte key.
    #[error("unwrapped key had unexpected length")]
    KeyLength,
    /// A stored nonce was not 24 bytes. XChaCha20's nonce type panics on any
    /// other length, and the envelope carrying it comes from a server we do not
    /// trust, so the length is checked rather than assumed.
    #[error("nonce had unexpected length")]
    NonceLength,
}

/// Argon2id work band accepted when unwrapping. The lower bound is what
/// `wrap_vrk_with_password` uses; the upper bound keeps a hostile wrapper from
/// asking the client for gigabytes.
pub const MIN_ARGON_M_KIB: u32 = 64 * 1024;
pub const MAX_ARGON_M_KIB: u32 = 1024 * 1024;
pub const MIN_ARGON_T: u32 = 3;
pub const MAX_ARGON_T: u32 = 16;
pub const MAX_ARGON_P: u32 = 4;

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
    // The envelope header and the bound AD must agree on the version, or the
    // version check above can be sidestepped by leaving the header at 1.
    if envelope.ad.envelope_version != envelope.version {
        return Err(VaultCryptoError::UnsupportedVersion(
            envelope.ad.envelope_version,
        ));
    }
    let expected = ad_digest(&envelope.ad)?;
    if expected != envelope.ad_digest {
        return Err(VaultCryptoError::AdMismatch);
    }
    let cipher = XChaCha20Poly1305::new_from_slice(&idk.0).map_err(|_| VaultCryptoError::Aead)?;
    let nonce = decode_nonce(&envelope.nonce)?;
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

/// Decrypt only when the caller's independently reconstructed context matches.
pub fn decrypt_item_with_ad(
    idk: &ItemDataKey,
    envelope: &EncryptedEnvelope,
    expected_ad: &AssociatedData,
) -> Result<Vec<u8>, VaultCryptoError> {
    if ad_digest(expected_ad)? != envelope.ad_digest {
        return Err(VaultCryptoError::AdMismatch);
    }
    decrypt_item(idk, envelope)
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
pub fn assert_argon_params_accepted(m_kib: u32, t: u32, p: u32) -> Result<(), VaultCryptoError> {
    if !(MIN_ARGON_M_KIB..=MAX_ARGON_M_KIB).contains(&m_kib)
        || !(MIN_ARGON_T..=MAX_ARGON_T).contains(&t)
        || p == 0
        || p > MAX_ARGON_P
    {
        return Err(VaultCryptoError::KdfParamsOutOfRange);
    }
    Ok(())
}

pub fn unwrap_vrk_with_password(
    password: &[u8],
    wrapper: &PasswordWrapper,
) -> Result<VaultRootKey, VaultCryptoError> {
    assert_argon_params_accepted(wrapper.params_m_kib, wrapper.params_t, wrapper.params_p)?;
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
    let mut ikm = [0u8; 32];
    argon
        .hash_password_into(password, &salt, &mut ikm)
        .map_err(|_| VaultCryptoError::Kdf)?;
    let mut kek = hkdf_expand(&ikm, b"opensesame/vault/vrk-wrap/v1")?;
    ikm.zeroize();
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| VaultCryptoError::Aead)?;
    kek.zeroize();
    let nonce = decode_nonce(&wrapper.nonce)?;
    let wrapped = STANDARD
        .decode(&wrapper.wrapped_vrk)
        .map_err(|_| VaultCryptoError::Aead)?;
    let mut key = cipher
        .decrypt(XNonce::from_slice(&nonce), wrapped.as_ref())
        .map_err(|_| VaultCryptoError::Aead)?;
    // Authentic but wrong-sized material must be an error, not a panic on
    // `copy_from_slice`.
    if key.len() != 32 {
        key.zeroize();
        return Err(VaultCryptoError::KeyLength);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&key);
    key.zeroize();
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

// ---------------------------------------------------------------------------
// Attachment chunk crypto (ADR 0054).
//
// Attachments are streamed, so they are sealed one bounded chunk at a time
// rather than through `encrypt_item`, whose whole-buffer base64-in-JSON
// envelope costs ~37% size and holds the entire payload in memory. A chunk is
// a raw binary frame; its associated data binds the attachment, the store
// path, and the chunk's position in the run, so a chunk cannot be reordered,
// dropped, appended to, or spliced in from another attachment.
// ---------------------------------------------------------------------------

/// Magic prefix of a sealed chunk frame.
pub const OSCHUNK_MAGIC: &[u8; 8] = b"OSCHNK1\n";

/// Bytes of frame that precede the ciphertext: magic followed by the nonce.
pub const OSCHUNK_HEADER_LEN: usize = OSCHUNK_MAGIC.len() + 24;

/// Poly1305 tag length; a frame shorter than header + tag cannot be authentic.
const AEAD_TAG_LEN: usize = 16;

/// Per-attachment content key. Derived from the item key and a random
/// attachment id, so two attachments of identical bytes never share a key —
/// content addressing over ciphertext then leaks no equality between them.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct AttachmentKey(pub [u8; 32]);

/// Context bound into every chunk frame as AEAD associated data.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct ChunkAd {
    pub envelope_version: u32,
    /// 32 lowercase hex characters identifying the attachment.
    pub attachment_id: String,
    /// Logical store path the attachment is filed under.
    pub item_id: String,
    /// 0-based position of this chunk.
    pub chunk_index: u32,
    /// Total chunks in the attachment; binding it defeats truncation.
    pub chunk_count: u32,
}

/// Derive the per-attachment content key.
pub fn derive_attachment_key(idk: &ItemDataKey, attachment_id: &[u8; 16]) -> AttachmentKey {
    let hk = Hkdf::<Sha256>::new(Some(attachment_id), &idk.0);
    let mut out = [0u8; 32];
    // A 32-byte expand from SHA-256 is always within HKDF's output bound, so
    // this cannot fail; keep the key type infallible for streaming callers.
    hk.expand(b"opensesame/sealed-store/attachment/v1", &mut out)
        .expect("32 bytes is within HKDF-SHA256 output length");
    AttachmentKey(out)
}

/// Digest of a chunk's associated data, used verbatim as the AEAD AAD.
pub fn chunk_ad_digest(ad: &ChunkAd) -> Result<String, VaultCryptoError> {
    let bytes = serde_json::to_vec(ad).map_err(|_| VaultCryptoError::Kdf)?;
    Ok(format!("blake3:{}", blake3::hash(&bytes).to_hex()))
}

/// Seal one plaintext chunk into a binary frame.
pub fn seal_chunk(
    key: &AttachmentKey,
    plaintext: &[u8],
    ad: &ChunkAd,
) -> Result<Vec<u8>, VaultCryptoError> {
    if ad.envelope_version != ENVELOPE_VERSION {
        return Err(VaultCryptoError::UnsupportedVersion(ad.envelope_version));
    }
    if ad.chunk_index >= ad.chunk_count {
        return Err(VaultCryptoError::AdMismatch);
    }
    let digest = chunk_ad_digest(ad)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key.0).map_err(|_| VaultCryptoError::Aead)?;
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
    let mut frame = Vec::with_capacity(OSCHUNK_HEADER_LEN + ct.len());
    frame.extend_from_slice(OSCHUNK_MAGIC);
    frame.extend_from_slice(&nonce);
    frame.extend_from_slice(&ct);
    Ok(frame)
}

/// Open a sealed chunk frame, requiring the caller's independently
/// reconstructed context to match what was sealed.
pub fn open_chunk(
    key: &AttachmentKey,
    frame: &[u8],
    ad: &ChunkAd,
) -> Result<Vec<u8>, VaultCryptoError> {
    if ad.envelope_version != ENVELOPE_VERSION {
        return Err(VaultCryptoError::UnsupportedVersion(ad.envelope_version));
    }
    if ad.chunk_index >= ad.chunk_count {
        return Err(VaultCryptoError::AdMismatch);
    }
    if !frame.starts_with(OSCHUNK_MAGIC) {
        return Err(VaultCryptoError::Aead);
    }
    // Reject anything too short to hold a nonce and a tag before indexing.
    if frame.len() < OSCHUNK_HEADER_LEN + AEAD_TAG_LEN {
        return Err(VaultCryptoError::NonceLength);
    }
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&frame[OSCHUNK_MAGIC.len()..OSCHUNK_HEADER_LEN]);
    let digest = chunk_ad_digest(ad)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key.0).map_err(|_| VaultCryptoError::Aead)?;
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &frame[OSCHUNK_HEADER_LEN..],
                aad: digest.as_bytes(),
            },
        )
        .map_err(|_| VaultCryptoError::Aead)
}

/// Decode a stored nonce, refusing any length XChaCha20 would panic on.
fn decode_nonce(encoded: &str) -> Result<[u8; 24], VaultCryptoError> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| VaultCryptoError::Aead)?;
    let nonce: [u8; 24] = bytes
        .try_into()
        .map_err(|_| VaultCryptoError::NonceLength)?;
    Ok(nonce)
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
    fn hostile_wrapper_params_are_refused_before_any_hashing() {
        let vrk = VaultRootKey::generate();
        let good = wrap_vrk_with_password(b"pw", &vrk).unwrap();

        // A server-supplied 4 GiB memory cost would be a client OOM, not a slow unwrap.
        let mut huge = good.clone();
        huge.params_m_kib = 4 * 1024 * 1024;
        assert!(matches!(
            unwrap_vrk_with_password(b"pw", &huge),
            Err(VaultCryptoError::KdfParamsOutOfRange)
        ));

        // Downgraded work factors weaken the wrap against an offline guesser.
        let mut weak = good.clone();
        weak.params_m_kib = 8;
        weak.params_t = 1;
        assert!(matches!(
            unwrap_vrk_with_password(b"pw", &weak),
            Err(VaultCryptoError::KdfParamsOutOfRange)
        ));

        let mut wide = good.clone();
        wide.params_p = 64;
        assert!(matches!(
            unwrap_vrk_with_password(b"pw", &wide),
            Err(VaultCryptoError::KdfParamsOutOfRange)
        ));

        // What we actually write stays inside the band.
        assert!(unwrap_vrk_with_password(b"pw", &good).is_ok());
    }

    #[test]
    fn the_accepted_band_brackets_what_we_write() {
        assert!(assert_argon_params_accepted(MIN_ARGON_M_KIB, MIN_ARGON_T, 1).is_ok());
        assert!(assert_argon_params_accepted(MAX_ARGON_M_KIB, MAX_ARGON_T, MAX_ARGON_P).is_ok());
        assert!(assert_argon_params_accepted(MIN_ARGON_M_KIB - 1, MIN_ARGON_T, 1).is_err());
        assert!(assert_argon_params_accepted(MIN_ARGON_M_KIB, MIN_ARGON_T, 0).is_err());
    }

    #[test]
    fn an_ad_version_bump_cannot_hide_behind_the_envelope_header() {
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
        env.ad.envelope_version = 99;
        env.ad_digest = ad_digest(&env.ad).unwrap();
        assert!(matches!(
            decrypt_item(&idk, &env),
            Err(VaultCryptoError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn a_stored_nonce_of_the_wrong_length_is_an_error_not_a_panic() {
        let idk = ItemDataKey::generate();
        let env = encrypt_item(
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

        // The envelope arrives through a server this crate does not trust, so every
        // length in it is untrusted input. `XNonce::from_slice` panics on anything
        // but 24 bytes, which turned a corrupt or hostile record into a crash.
        for len in [0usize, 5, 12, 23, 25, 64] {
            let mut hostile = env.clone();
            hostile.nonce = STANDARD.encode(vec![0u8; len]);
            assert!(matches!(
                decrypt_item(&idk, &hostile),
                Err(VaultCryptoError::NonceLength)
            ));
        }

        // Base64 that decodes to nothing usable is still refused, not decoded.
        let mut garbage = env.clone();
        garbage.nonce = "!!!not base64!!!".into();
        assert!(matches!(
            decrypt_item(&idk, &garbage),
            Err(VaultCryptoError::Aead)
        ));

        // The nonce we write is accepted.
        assert_eq!(decrypt_item(&idk, &env).unwrap(), b"x");
    }

    #[test]
    fn a_wrapper_nonce_of_the_wrong_length_is_an_error_not_a_panic() {
        let vrk = VaultRootKey::generate();
        let good = wrap_vrk_with_password(b"pw", &vrk).unwrap();
        for len in [0usize, 5, 23, 25] {
            let mut hostile = good.clone();
            hostile.nonce = STANDARD.encode(vec![0u8; len]);
            assert!(matches!(
                unwrap_vrk_with_password(b"pw", &hostile),
                Err(VaultCryptoError::NonceLength)
            ));
        }
        assert_eq!(unwrap_vrk_with_password(b"pw", &good).unwrap().0, vrk.0);
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

#[cfg(test)]
mod pact {
    use super::*;

    #[test]
    fn property_kdf_band_accepts_what_wrap_writes() {
        assert!(assert_argon_params_accepted(MIN_ARGON_M_KIB, MIN_ARGON_T, 1).is_ok());
        assert!(assert_argon_params_accepted(MAX_ARGON_M_KIB, MAX_ARGON_T, MAX_ARGON_P).is_ok());
    }

    #[test]
    fn adversarial_hostile_kdf_params_fail_closed() {
        assert!(assert_argon_params_accepted(MIN_ARGON_M_KIB - 1, MIN_ARGON_T, 1).is_err());
        assert!(assert_argon_params_accepted(MAX_ARGON_M_KIB + 1, MIN_ARGON_T, 1).is_err());
        assert!(assert_argon_params_accepted(MIN_ARGON_M_KIB, MIN_ARGON_T, 0).is_err());
        assert!(
            assert_argon_params_accepted(MIN_ARGON_M_KIB, MIN_ARGON_T, MAX_ARGON_P + 1).is_err()
        );
    }

    #[test]
    fn chaos_many_bad_nonces_never_panic() {
        let idk = ItemDataKey::generate();
        let env = encrypt_item(
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
        for len in [0usize, 1, 12, 23, 25, 64] {
            let mut hostile = env.clone();
            hostile.nonce = STANDARD.encode(vec![0u8; len]);
            assert!(decrypt_item(&idk, &hostile).is_err());
        }
    }

    #[test]
    fn contract_envelopes_are_ciphertext_only() {
        let idk = ItemDataKey::generate();
        let env = encrypt_item(
            &idk,
            b"secret-item",
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
        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains("secret-item"));
        assert!(!json.contains("access_token"));
        assert_eq!(decrypt_item(&idk, &env).unwrap(), b"secret-item");
    }
}
