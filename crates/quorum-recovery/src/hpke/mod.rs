//! Hybrid Public Key Encryption, RFC 9180, base mode, with the one KEM and KDF
//! the trusted-contacts format uses: DHKEM(X25519, HKDF-SHA256) and
//! HKDF-SHA256, paired with AES-128-GCM or ChaCha20-Poly1305.
//!
//! This is the native twin of `packages/app-core/src/lib/quorum/hpke.ts`. Both
//! are checked against the same file, `spec/conformance/hpke-rfc9180-vectors.json`
//! (Appendix A.1 and A.2: key pairs, shared secret, key schedule, nonces and
//! ciphertexts through sequence 256, exporter values), and against each other
//! through the interop fixture (ADR 0139). The key schedule is written out
//! over `hkdf` rather than imported, so the code reads as the RFC does.

mod context;
mod kdf;

use rand::RngCore;
use x25519_dalek::{PublicKey, StaticSecret};

pub use context::Context;
use kdf::{kem_suite, labeled_expand, labeled_extract};

use crate::secret::Secret;

const HASH_LENGTH: usize = 32;
const KEY_LENGTH: usize = 32;

/// Why an HPKE operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HpkeError {
    /// An X25519 public key is 32 bytes.
    #[error("an X25519 key is 32 bytes")]
    KeyLength,
    /// RFC 9180 section 7.1.4: a low-order point gives an all-zero output.
    #[error("the Diffie-Hellman output is all zero")]
    LowOrderPoint,
    /// Wrong key, info, AAD, AEAD or a changed ciphertext.
    #[error("the ciphertext did not authenticate")]
    Authentication,
    /// The sequence number would wrap.
    #[error("the message limit of this context is reached")]
    MessageLimit,
    /// HKDF refused a length (an exporter longer than 255 hash blocks).
    #[error("the requested output length is too long")]
    Length,
}

/// The AEAD half of the cipher suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HpkeAead {
    /// AES-128-GCM, RFC 9180 AEAD id 0x0001.
    Aes128Gcm,
    /// ChaCha20-Poly1305, RFC 9180 AEAD id 0x0003.
    ChaCha20Poly1305,
}

impl HpkeAead {
    fn id(self) -> u16 {
        match self {
            Self::Aes128Gcm => 0x0001,
            Self::ChaCha20Poly1305 => 0x0003,
        }
    }

    fn key_length(self) -> usize {
        match self {
            Self::Aes128Gcm => 16,
            Self::ChaCha20Poly1305 => KEY_LENGTH,
        }
    }

    /// The suite for an RFC 9180 AEAD identifier, if this crate implements it.
    #[must_use]
    pub fn from_id(id: u16) -> Option<Self> {
        match id {
            0x0001 => Some(Self::Aes128Gcm),
            0x0003 => Some(Self::ChaCha20Poly1305),
            _ => None,
        }
    }
}

/// An X25519 key pair as RFC 9180 handles it.
pub struct KeyPair {
    /// The secret scalar, 32 bytes.
    pub secret_key: Secret,
    /// The public key, 32 bytes.
    pub public_key: [u8; 32],
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair")
            .field("secret_key", &self.secret_key)
            .field("public_key", &self.public_key)
            .finish()
    }
}

fn secret_of(bytes: &[u8]) -> Result<StaticSecret, HpkeError> {
    let mut array: [u8; 32] = bytes.try_into().map_err(|_| HpkeError::KeyLength)?;
    let secret = StaticSecret::from(array);
    zeroize::Zeroize::zeroize(&mut array);
    Ok(secret)
}

/// The key pair for a secret scalar.
///
/// # Errors
/// [`HpkeError::KeyLength`] unless `secret_key` is 32 bytes.
pub fn key_pair_from_secret(secret_key: &[u8]) -> Result<KeyPair, HpkeError> {
    let secret = secret_of(secret_key)?;
    Ok(KeyPair {
        public_key: *PublicKey::from(&secret).as_bytes(),
        secret_key: Secret::new(secret_key.to_vec()),
    })
}

/// A fresh key pair.
pub fn generate_key_pair<R: RngCore + ?Sized>(rng: &mut R) -> KeyPair {
    let mut scalar = [0_u8; 32];
    rng.fill_bytes(&mut scalar);
    let secret = StaticSecret::from(scalar);
    let pair = KeyPair {
        public_key: *PublicKey::from(&secret).as_bytes(),
        secret_key: Secret::new(scalar.to_vec()),
    };
    zeroize::Zeroize::zeroize(&mut scalar);
    pair
}

/// DeriveKeyPair(ikm), RFC 9180 section 7.1.3. Deterministic; for vectors.
///
/// # Errors
/// [`HpkeError`] when HKDF refuses the lengths (it does not for these).
pub fn derive_key_pair(ikm: &[u8]) -> Result<KeyPair, HpkeError> {
    let suite = kem_suite();
    let prk = labeled_extract(&suite, &[], "dkp_prk", ikm);
    let secret = labeled_expand(&suite, prk.expose(), "sk", &[], 32)?;
    key_pair_from_secret(secret.expose())
}

fn diffie_hellman(secret_key: &[u8], public_key: &[u8]) -> Result<Secret, HpkeError> {
    let secret = secret_of(secret_key)?;
    let public: [u8; 32] = public_key.try_into().map_err(|_| HpkeError::KeyLength)?;
    let shared = secret.diffie_hellman(&PublicKey::from(public));
    if !shared.was_contributory() {
        return Err(HpkeError::LowOrderPoint);
    }
    Ok(Secret::new(shared.as_bytes().to_vec()))
}

fn shared_secret_of(dh: &Secret, enc: &[u8], recipient_public: &[u8]) -> Result<Secret, HpkeError> {
    let suite = kem_suite();
    let prk = labeled_extract(&suite, &[], "eae_prk", dh.expose());
    let mut context = enc.to_vec();
    context.extend_from_slice(recipient_public);
    labeled_expand(&suite, prk.expose(), "shared_secret", &context, HASH_LENGTH)
}

/// SetupBaseS(pkR, info) with the ephemeral key given. Use [`seal_base`] unless
/// reproducing a vector.
///
/// # Errors
/// [`HpkeError`] for a bad key or a low-order point.
pub fn setup_base_sender(
    recipient_public: &[u8],
    info: &[u8],
    aead: HpkeAead,
    ephemeral: &KeyPair,
) -> Result<(Vec<u8>, Context), HpkeError> {
    let dh = diffie_hellman(ephemeral.secret_key.expose(), recipient_public)?;
    let enc = ephemeral.public_key.to_vec();
    let shared = shared_secret_of(&dh, &enc, recipient_public)?;
    Ok((enc, Context::new(aead, shared, info)?))
}

/// SetupBaseR(enc, skR, info).
///
/// # Errors
/// [`HpkeError`] for a bad key or a low-order point.
pub fn setup_base_recipient(
    enc: &[u8],
    recipient_secret: &[u8],
    info: &[u8],
    aead: HpkeAead,
) -> Result<Context, HpkeError> {
    let dh = diffie_hellman(recipient_secret, enc)?;
    let recipient_public = *PublicKey::from(&secret_of(recipient_secret)?).as_bytes();
    let shared = shared_secret_of(&dh, enc, &recipient_public)?;
    Context::new(aead, shared, info)
}

/// The single-shot Seal of RFC 9180 section 6.1: `(enc, ciphertext)`.
///
/// # Errors
/// [`HpkeError`] for a bad recipient key.
pub fn seal_base<R: RngCore + ?Sized>(
    rng: &mut R,
    recipient_public: &[u8],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
    suite: HpkeAead,
) -> Result<(Vec<u8>, Vec<u8>), HpkeError> {
    let ephemeral = generate_key_pair(rng);
    let (enc, mut session) = setup_base_sender(recipient_public, info, suite, &ephemeral)?;
    Ok((enc, session.seal(aad, plaintext)?))
}

/// The single-shot Open of RFC 9180 section 6.1.
///
/// # Errors
/// [`HpkeError::Authentication`] for a wrong key, `info`, `aad` or AEAD, or a
/// changed ciphertext; other variants for malformed keys.
pub fn open_base(
    recipient_secret: &[u8],
    enc: &[u8],
    info: &[u8],
    aad: &[u8],
    ciphertext: &[u8],
    suite: HpkeAead,
) -> Result<Secret, HpkeError> {
    let mut session = setup_base_recipient(enc, recipient_secret, info, suite)?;
    session.open(aad, ciphertext).map(Secret::new)
}
