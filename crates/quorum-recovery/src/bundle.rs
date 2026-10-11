//! The recovery bundle `sealBundle` writes (`quorum/circle.ts`): the payload
//! encrypted under a key only the recombined SLIP-0039 secret derives, with the
//! owner's signed policy beside it, safe to store anywhere.
//!
//! The key is HKDF-SHA256 over the secret, salted with the circle id and
//! bound to the circle and epoch; the cipher is XChaCha20-Poly1305 and its
//! associated data names the policy digest, the circle and the epoch, so a
//! bundle cannot be opened as another circle's or another epoch's.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::canonical::frame;
use crate::encoding::{b64url_decode, b64url_encode, is_b64url_charset};
use crate::policy::{verify_signed_policy, PolicyError, SignedPolicy};
use crate::secret::Secret;

const COLLECTION_SALT: &str = "opensesame:quorum-collection-salt:v1";
const COLLECTION_INFO: &str = "opensesame:quorum-collection:v1";
const COLLECTION_AAD: &str = "opensesame:quorum-collection-aad:v1";
const NONCE_LENGTH: usize = 24;

/// Why a bundle was refused or did not open.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BundleError {
    /// The file is not a recovery bundle.
    #[error("not a recovery bundle: {0}")]
    Malformed(String),
    /// The embedded policy is not the owner's, or is not sound.
    #[error("the bundle's policy is refused: {0}")]
    Policy(#[from] PolicyError),
    /// The secret, the circle or the bytes are wrong.
    #[error("the recovery secret does not open this bundle")]
    Open,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawBundle {
    v: u64,
    signed_policy: Value,
    nonce: String,
    ciphertext: String,
}

/// A bundle whose policy has been verified; the payload is still sealed.
#[derive(Debug, Clone)]
pub struct RecoveryBundle {
    /// The owner's signed policy.
    pub signed_policy: SignedPolicy,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

impl RecoveryBundle {
    /// Read a bundle from its JSON text and verify its policy.
    ///
    /// # Errors
    /// [`BundleError`] for a document that is not a bundle or whose policy
    /// fails any of the checks in [`verify_signed_policy`].
    pub fn parse(text: &str, pinned_owner_key: Option<&str>) -> Result<Self, BundleError> {
        let value: Value =
            serde_json::from_str(text).map_err(|e| BundleError::Malformed(e.to_string()))?;
        Self::from_value(&value, pinned_owner_key)
    }

    /// As [`RecoveryBundle::parse`], from a parsed document.
    ///
    /// # Errors
    /// As [`RecoveryBundle::parse`].
    pub fn from_value(value: &Value, pinned_owner_key: Option<&str>) -> Result<Self, BundleError> {
        let raw: RawBundle = serde_json::from_value(value.clone())
            .map_err(|e| BundleError::Malformed(e.to_string()))?;
        if raw.v != 1 {
            return Err(BundleError::Malformed("unknown version".to_owned()));
        }
        if !is_b64url_charset(&raw.nonce) || !is_b64url_charset(&raw.ciphertext) {
            return Err(BundleError::Malformed("not base64url".to_owned()));
        }
        let signed_policy = verify_signed_policy(&raw.signed_policy, pinned_owner_key)?;
        let decode = |text: &str| {
            b64url_decode(text).map_err(|_| BundleError::Malformed("not base64url".to_owned()))
        };
        Ok(Self {
            signed_policy,
            nonce: decode(&raw.nonce)?,
            ciphertext: decode(&raw.ciphertext)?,
        })
    }

    /// The bundle as `sealBundle` writes it.
    #[must_use]
    pub fn to_value(&self) -> Value {
        json!({
            "v": 1,
            "signedPolicy": self.signed_policy.document(),
            "nonce": b64url_encode(&self.nonce),
            "ciphertext": b64url_encode(&self.ciphertext),
        })
    }

    /// The payload bytes, once the recovery secret is recombined: the JSON
    /// text that was sealed, unchanged.
    ///
    /// # Errors
    /// [`BundleError::Open`] for any failure to authenticate or to read the
    /// plaintext as UTF-8 JSON; the cause is deliberately not told apart.
    pub fn open(&self, recovery_secret: &[u8]) -> Result<Secret, BundleError> {
        let key = collection_key(recovery_secret, &self.signed_policy)?;
        let cipher =
            XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| BundleError::Open)?;
        if self.nonce.len() != NONCE_LENGTH {
            return Err(BundleError::Open);
        }
        let aad = collection_aad(&self.signed_policy);
        let opened = cipher
            .decrypt(
                XNonce::from_slice(&self.nonce),
                Payload {
                    msg: &self.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| BundleError::Open)?;
        let opened = Secret::new(opened);
        // `openBundle` parses the plaintext as UTF-8 JSON; so does this.
        serde_json::from_slice::<serde::de::IgnoredAny>(opened.expose())
            .map_err(|_| BundleError::Open)?;
        Ok(opened)
    }

    /// Encrypt `payload` (JSON text) under the secret's collection key: the
    /// native twin of `sealBundle`, here for the interop tests.
    ///
    /// # Errors
    /// [`BundleError::Open`] if the cipher refuses the inputs.
    pub fn seal(
        signed_policy: SignedPolicy,
        recovery_secret: &[u8],
        nonce: [u8; NONCE_LENGTH],
        payload: &[u8],
    ) -> Result<Self, BundleError> {
        let key = collection_key(recovery_secret, &signed_policy)?;
        let cipher =
            XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| BundleError::Open)?;
        let aad = collection_aad(&signed_policy);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: payload,
                    aad: &aad,
                },
            )
            .map_err(|_| BundleError::Open)?;
        Ok(Self {
            signed_policy,
            nonce: nonce.to_vec(),
            ciphertext,
        })
    }
}

fn collection_key(
    recovery_secret: &[u8],
    signed: &SignedPolicy,
) -> Result<Zeroizing<[u8; 32]>, BundleError> {
    let circle_id = signed.policy.circle_id.as_str();
    let epoch = signed.policy.epoch.to_string();
    let salt = Sha256::digest(frame(&[COLLECTION_SALT, circle_id]));
    let info = frame(&[COLLECTION_INFO, circle_id, &epoch]);
    let mut key = Zeroizing::new([0_u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), recovery_secret)
        .expand(&info, key.as_mut())
        .map_err(|_| BundleError::Open)?;
    Ok(key)
}

fn collection_aad(signed: &SignedPolicy) -> Vec<u8> {
    frame(&[
        COLLECTION_AAD,
        &signed.digest,
        &signed.policy.circle_id,
        &signed.policy.epoch.to_string(),
    ])
}
