//! Custody-agnostic signing (ADR 0066 domain model).
//!
//! Certificate, CRL and OCSP signing all go through [`Signer`], so the same
//! issuance code path works whether the private key is sealed on the Host or
//! lives behind a PKCS#11 token. The sealed-key implementation is
//! [`SealedKeySigner`]; the HSM implementation is added by the external-CA and
//! HSM swarm without touching this module.
//!
//! Secrecy invariant: a `Signer` exposes only `algorithm`, `public_key_der`
//! and `sign`. There is no accessor for private material, [`SealedKeySigner`]
//! is neither `Clone` nor `Serialize`, and its `Debug` is redacted.

use pkcs8::DecodePrivateKey as _;
use sha2::{Sha256, Sha384, Sha512};
use signature::{SignatureEncoding as _, Signer as _, Verifier as _};
use spki::DecodePublicKey as _;

use crate::error::PkiError;
use crate::keys::KeyPair;
use crate::types::SignatureAlgorithm;

/// Produces signatures over arbitrary messages with a private key whose
/// custody this crate does not need to know about.
pub trait Signer: Send + Sync {
    /// The signature algorithm this signer produces.
    fn algorithm(&self) -> SignatureAlgorithm;

    /// The DER-encoded `SubjectPublicKeyInfo` of the signing key.
    fn public_key_der(&self) -> Vec<u8>;

    /// Signs `message`, returning the raw signature bytes as they appear in an
    /// X.509 `signatureValue` (DER-encoded `ECDSA-Sig-Value` for ECDSA).
    ///
    /// # Errors
    /// Returns [`PkiError::Signing`] when the backing key or token refuses to
    /// produce a signature.
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, PkiError>;
}

/// The concrete signing key behind a [`SealedKeySigner`].
enum SigningKey {
    Rsa256(Box<rsa::pkcs1v15::SigningKey<Sha256>>),
    Rsa384(Box<rsa::pkcs1v15::SigningKey<Sha384>>),
    Rsa512(Box<rsa::pkcs1v15::SigningKey<Sha512>>),
    P256(Box<p256::ecdsa::SigningKey>),
    P384(Box<p384::ecdsa::SigningKey>),
    Ed25519(Box<ed25519_dalek::SigningKey>),
}

/// A [`Signer`] backed by a key pair held in this process — the custody model
/// used for Host-sealed CA, leaf and code-signing keys.
pub struct SealedKeySigner {
    algorithm: SignatureAlgorithm,
    public_key_der: Vec<u8>,
    key: SigningKey,
}

// The omitted field carries private key material. Printing it would defeat the
// crate's secrecy invariant (see the crate docs) and leak keys into logs and
// panic output, so the redaction is deliberate.
#[allow(clippy::missing_fields_in_debug)]
impl std::fmt::Debug for SealedKeySigner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SealedKeySigner")
            .field("algorithm", &self.algorithm)
            .field("private", &"<redacted>")
            .finish()
    }
}

impl SealedKeySigner {
    /// Builds a signer over `key`, using the default signature algorithm for
    /// the key's kind.
    ///
    /// # Errors
    /// Returns [`PkiError::KeyGeneration`] when the key's PKCS#8 encoding
    /// cannot be re-parsed by the signing backend.
    pub fn new(key: &KeyPair) -> Result<Self, PkiError> {
        Self::with_algorithm(key, key.algorithm().default_signature_algorithm())
    }

    /// Builds a signer over `key` that produces `algorithm` signatures.
    ///
    /// # Errors
    /// Returns [`PkiError::UnsupportedAlgorithm`] when `algorithm` cannot be
    /// produced by a key of this kind, or [`PkiError::KeyGeneration`] when the
    /// key's PKCS#8 encoding cannot be re-parsed.
    pub fn with_algorithm(key: &KeyPair, algorithm: SignatureAlgorithm) -> Result<Self, PkiError> {
        if !key.algorithm().supports(algorithm) {
            return Err(PkiError::UnsupportedAlgorithm);
        }
        let pem = key.private_key_pkcs8_pem();
        let signing = match algorithm {
            SignatureAlgorithm::Sha256Rsa => SigningKey::Rsa256(Box::new(
                rsa::pkcs1v15::SigningKey::<Sha256>::from_pkcs8_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?,
            )),
            SignatureAlgorithm::Sha384Rsa => SigningKey::Rsa384(Box::new(
                rsa::pkcs1v15::SigningKey::<Sha384>::from_pkcs8_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?,
            )),
            SignatureAlgorithm::Sha512Rsa => SigningKey::Rsa512(Box::new(
                rsa::pkcs1v15::SigningKey::<Sha512>::from_pkcs8_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?,
            )),
            SignatureAlgorithm::Sha256Ecdsa => SigningKey::P256(Box::new(
                p256::ecdsa::SigningKey::from_pkcs8_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?,
            )),
            SignatureAlgorithm::Sha384Ecdsa => SigningKey::P384(Box::new(
                p384::ecdsa::SigningKey::from_pkcs8_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?,
            )),
            SignatureAlgorithm::Ed25519 => SigningKey::Ed25519(Box::new(
                ed25519_dalek::SigningKey::from_pkcs8_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?,
            )),
        };
        Ok(Self {
            algorithm,
            public_key_der: key.public_key_der(),
            key: signing,
        })
    }
}

impl Signer for SealedKeySigner {
    fn algorithm(&self) -> SignatureAlgorithm {
        self.algorithm
    }

    fn public_key_der(&self) -> Vec<u8> {
        self.public_key_der.clone()
    }

    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, PkiError> {
        let signature = match &self.key {
            SigningKey::Rsa256(key) => key
                .try_sign(message)
                .map_err(|_| PkiError::Signing)?
                .to_vec(),
            SigningKey::Rsa384(key) => key
                .try_sign(message)
                .map_err(|_| PkiError::Signing)?
                .to_vec(),
            SigningKey::Rsa512(key) => key
                .try_sign(message)
                .map_err(|_| PkiError::Signing)?
                .to_vec(),
            SigningKey::P256(key) => {
                let signature: p256::ecdsa::DerSignature =
                    key.try_sign(message).map_err(|_| PkiError::Signing)?;
                signature.as_bytes().to_vec()
            }
            SigningKey::P384(key) => {
                let signature: p384::ecdsa::DerSignature =
                    key.try_sign(message).map_err(|_| PkiError::Signing)?;
                signature.as_bytes().to_vec()
            }
            SigningKey::Ed25519(key) => key
                .try_sign(message)
                .map_err(|_| PkiError::Signing)?
                .to_vec(),
        };
        Ok(signature)
    }
}

/// Verifies `signature` over `message` against a DER-encoded
/// `SubjectPublicKeyInfo`.
///
/// This is the counterpart to [`Signer::sign`] and is what the CRL and OCSP
/// paths use to prove that what they emitted is verifiable by a relying party
/// holding only the issuer certificate.
///
/// # Errors
/// Returns [`PkiError::InvalidDer`] when `public_key_der` is not a
/// `SubjectPublicKeyInfo` for `algorithm`, or [`PkiError::SignatureInvalid`]
/// when the signature does not verify.
pub fn verify(
    algorithm: SignatureAlgorithm,
    public_key_der: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), PkiError> {
    /// Verifies one RSASSA-PKCS1-v1_5 signature under the named digest.
    macro_rules! verify_rsa {
        ($digest:ty) => {{
            let key = rsa::pkcs1v15::VerifyingKey::<$digest>::from_public_key_der(public_key_der)
                .map_err(|_| PkiError::InvalidDer)?;
            let parsed = rsa::pkcs1v15::Signature::try_from(signature)
                .map_err(|_| PkiError::SignatureInvalid)?;
            key.verify(message, &parsed)
                .map_err(|_| PkiError::SignatureInvalid)
        }};
    }

    match algorithm {
        SignatureAlgorithm::Sha256Rsa => verify_rsa!(Sha256),
        SignatureAlgorithm::Sha384Rsa => verify_rsa!(Sha384),
        SignatureAlgorithm::Sha512Rsa => verify_rsa!(Sha512),
        SignatureAlgorithm::Sha256Ecdsa => {
            let key = p256::ecdsa::VerifyingKey::from_public_key_der(public_key_der)
                .map_err(|_| PkiError::InvalidDer)?;
            let parsed = p256::ecdsa::DerSignature::try_from(signature)
                .map_err(|_| PkiError::SignatureInvalid)?;
            key.verify(message, &parsed)
                .map_err(|_| PkiError::SignatureInvalid)
        }
        SignatureAlgorithm::Sha384Ecdsa => {
            let key = p384::ecdsa::VerifyingKey::from_public_key_der(public_key_der)
                .map_err(|_| PkiError::InvalidDer)?;
            let parsed = p384::ecdsa::DerSignature::try_from(signature)
                .map_err(|_| PkiError::SignatureInvalid)?;
            key.verify(message, &parsed)
                .map_err(|_| PkiError::SignatureInvalid)
        }
        SignatureAlgorithm::Ed25519 => {
            let key = ed25519_dalek::VerifyingKey::from_public_key_der(public_key_der)
                .map_err(|_| PkiError::InvalidDer)?;
            let parsed = ed25519_dalek::Signature::try_from(signature)
                .map_err(|_| PkiError::SignatureInvalid)?;
            key.verify(message, &parsed)
                .map_err(|_| PkiError::SignatureInvalid)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys;
    use crate::types::KeyAlgorithm;

    #[test]
    fn every_algorithm_signs_and_verifies_its_own_message() {
        for algorithm in [
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
            KeyAlgorithm::Ed25519,
            KeyAlgorithm::Rsa2048,
        ] {
            let key = keys::generate(algorithm).unwrap();
            let signer = SealedKeySigner::new(&key).unwrap();
            let signature = signer.sign(b"authorize this").unwrap();
            assert_eq!(signer.algorithm(), algorithm.default_signature_algorithm());
            verify(
                signer.algorithm(),
                &signer.public_key_der(),
                b"authorize this",
                &signature,
            )
            .unwrap();
        }
    }

    #[test]
    fn a_tampered_message_or_signature_fails_verification() {
        let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        let signer = SealedKeySigner::new(&key).unwrap();
        let signature = signer.sign(b"original").unwrap();
        assert_eq!(
            verify(
                signer.algorithm(),
                &signer.public_key_der(),
                b"tampered",
                &signature
            )
            .unwrap_err(),
            PkiError::SignatureInvalid
        );
        let mut broken = signature.clone();
        let last = broken.len() - 1;
        broken[last] ^= 0xff;
        assert!(verify(
            signer.algorithm(),
            &signer.public_key_der(),
            b"original",
            &broken
        )
        .is_err());
    }

    #[test]
    fn rsa_signs_under_each_permitted_digest() {
        let key = keys::generate(KeyAlgorithm::Rsa2048).unwrap();
        for algorithm in [
            SignatureAlgorithm::Sha256Rsa,
            SignatureAlgorithm::Sha384Rsa,
            SignatureAlgorithm::Sha512Rsa,
        ] {
            let signer = SealedKeySigner::with_algorithm(&key, algorithm).unwrap();
            let signature = signer.sign(b"payload").unwrap();
            verify(algorithm, &signer.public_key_der(), b"payload", &signature).unwrap();
        }
    }

    #[test]
    fn a_key_cannot_be_asked_for_an_algorithm_it_cannot_produce() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        assert_eq!(
            SealedKeySigner::with_algorithm(&key, SignatureAlgorithm::Sha256Rsa).unwrap_err(),
            PkiError::UnsupportedAlgorithm
        );
        let ecdsa = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        assert_eq!(
            SealedKeySigner::with_algorithm(&ecdsa, SignatureAlgorithm::Sha384Ecdsa).unwrap_err(),
            PkiError::UnsupportedAlgorithm
        );
    }

    #[test]
    fn verification_rejects_a_public_key_of_the_wrong_shape() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let signer = SealedKeySigner::new(&key).unwrap();
        let signature = signer.sign(b"x").unwrap();
        assert_eq!(
            verify(SignatureAlgorithm::Ed25519, b"", b"x", &signature).unwrap_err(),
            PkiError::InvalidDer
        );
        assert_eq!(
            verify(
                SignatureAlgorithm::Sha256Ecdsa,
                &signer.public_key_der(),
                b"x",
                &signature
            )
            .unwrap_err(),
            PkiError::InvalidDer
        );
    }

    #[test]
    fn debug_never_renders_private_material() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let signer = SealedKeySigner::new(&key).unwrap();
        assert_eq!(
            format!("{signer:?}"),
            "SealedKeySigner { algorithm: Ed25519, private: \"<redacted>\" }"
        );
    }

    #[test]
    fn the_trait_is_object_safe_so_custody_can_vary_at_runtime() {
        let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        let signer: Box<dyn Signer> = Box::new(SealedKeySigner::new(&key).unwrap());
        let signature = signer.sign(b"dynamic").unwrap();
        verify(
            signer.algorithm(),
            &signer.public_key_der(),
            b"dynamic",
            &signature,
        )
        .unwrap();
    }
}
