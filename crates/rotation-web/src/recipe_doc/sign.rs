//! Canonical form, signing and verification of a recipe document.
//!
//! The signed message is a domain tag, then the document without its
//! `signature`, in RFC 8785 canonical JSON (the canonicalization agent-hooks
//! already pins, so there is one implementation in the repository). The tag
//! stops a signature made for a recipe from being replayed as any other
//! Ed25519 message the same key might sign, and the canonical form means two
//! encoders that disagree on whitespace or key order still agree on the bytes.
//!
//! Keys travel as lowercase hex: a public key is 64 characters, a private seed
//! the same, a signature 128. Hex rather than base64 because the crate's
//! default build links neither (`tests/default_build.rs`), and a recipe is
//! read by people before it is trusted by machines.

use agent_hooks::canonical_json;
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use sha2::{Digest as _, Sha256};

use super::{RecipeDocument, RecipeError, RecipeSignature};

/// The one algorithm a recipe signature may name.
pub const SIGNATURE_ALGORITHM: &str = "ed25519";

/// The tag every signed message begins with.
pub const SIGNING_DOMAIN: &str = "opensesame/web-login-recipe/v1\n";

/// `rsk_` and the first 32 hex characters of the SHA-256 of the public key:
/// the name an organization pins a signer under.
#[must_use]
pub fn key_id_of(key: &VerifyingKey) -> String {
    let digest = Sha256::digest(key.as_bytes());
    format!("rsk_{}", &hex::encode(digest)[..32])
}

/// A public key from its 64-character hex.
///
/// # Errors
///
/// [`RecipeError::BadKey`] when it is not 32 bytes of hex or not a point.
pub fn parse_public_key_hex(text: &str) -> Result<VerifyingKey, RecipeError> {
    let bytes: [u8; 32] = hex::decode(text.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(RecipeError::BadKey(
            "a public key is 32 bytes as 64 hex characters",
        ))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| RecipeError::BadKey("that is not an Ed25519 public key"))
}

/// A signing key from its 64-character hex seed.
///
/// # Errors
///
/// [`RecipeError::BadKey`] when it is not 32 bytes of hex. The text is never
/// echoed.
pub fn signing_key_from_seed_hex(text: &str) -> Result<SigningKey, RecipeError> {
    let seed: [u8; 32] = hex::decode(text.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(RecipeError::BadKey(
            "a signing key is a 32-byte seed as 64 hex characters",
        ))?;
    Ok(SigningKey::from_bytes(&seed))
}

impl RecipeDocument {
    /// The bytes a signature covers.
    ///
    /// # Errors
    ///
    /// [`RecipeError::Malformed`] when the document cannot be written as JSON
    /// (it always can for a parsed one).
    pub fn signing_message(&self) -> Result<Vec<u8>, RecipeError> {
        let value = serde_json::to_value(self.unsigned())
            .map_err(|failure| RecipeError::Malformed(failure.to_string()))?;
        let mut message = SIGNING_DOMAIN.as_bytes().to_vec();
        message.extend_from_slice(canonical_json(&value).as_bytes());
        Ok(message)
    }

    /// `sha256:` and the hex digest of the signed message: the document's
    /// identity, independent of its signature. A run records which one it
    /// replayed.
    ///
    /// # Errors
    ///
    /// As [`signing_message`](Self::signing_message).
    pub fn digest(&self) -> Result<String, RecipeError> {
        Ok(format!(
            "sha256:{}",
            hex::encode(Sha256::digest(self.signing_message()?))
        ))
    }

    /// Sign the document, replacing any signature it carries.
    ///
    /// # Errors
    ///
    /// As [`signing_message`](Self::signing_message).
    pub fn sign(&mut self, key: &SigningKey) -> Result<(), RecipeError> {
        let signature = key.sign(&self.signing_message()?);
        self.signature = Some(RecipeSignature {
            alg: SIGNATURE_ALGORITHM.into(),
            key_id: key_id_of(&key.verifying_key()),
            value: hex::encode(signature.to_bytes()),
        });
        Ok(())
    }

    /// The key id the document's signature names.
    ///
    /// # Errors
    ///
    /// [`RecipeError::Unsigned`] when it carries no signature.
    pub fn signer_key_id(&self) -> Result<&str, RecipeError> {
        self.signature
            .as_ref()
            .map(|signature| signature.key_id.as_str())
            .ok_or(RecipeError::Unsigned)
    }

    /// Whether `key` signed exactly this document. Strict: a weak or
    /// non-canonical signature is refused.
    ///
    /// # Errors
    ///
    /// [`RecipeError::Unsigned`], [`UnsupportedAlgorithm`](RecipeError::UnsupportedAlgorithm),
    /// [`KeyMismatch`](RecipeError::KeyMismatch) when the signature names
    /// another key, or [`BadSignature`](RecipeError::BadSignature).
    pub fn verify(&self, key: &VerifyingKey) -> Result<(), RecipeError> {
        let signature = self.signature.as_ref().ok_or(RecipeError::Unsigned)?;
        if signature.alg != SIGNATURE_ALGORITHM {
            return Err(RecipeError::UnsupportedAlgorithm);
        }
        if signature.key_id != key_id_of(key) {
            return Err(RecipeError::KeyMismatch);
        }
        let bytes: [u8; 64] = hex::decode(&signature.value)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(RecipeError::BadSignature)?;
        key.verify_strict(&self.signing_message()?, &Signature::from_bytes(&bytes))
            .map_err(|_| RecipeError::BadSignature)
    }
}
