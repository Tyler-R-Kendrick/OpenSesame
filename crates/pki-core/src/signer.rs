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

use aws_lc_rs::{rand::SystemRandom, signature as aws_signature};
use p256::ecdsa::signature::{Signer as _, Verifier as _};
use p256::pkcs8::{DecodePrivateKey as _, DecodePublicKey as _};
use pkcs8::DecodePrivateKey as _;
use signature::{Signer as _, Verifier as _};
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
    Rsa(Box<aws_signature::RsaKeyPair>),
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
            SignatureAlgorithm::Sha256Rsa
            | SignatureAlgorithm::Sha384Rsa
            | SignatureAlgorithm::Sha512Rsa => {
                let der = pkcs8::SecretDocument::from_pem(&pem)
                    .map_err(|_| PkiError::KeyGeneration)?
                    .1;
                SigningKey::Rsa(Box::new(
                    aws_signature::RsaKeyPair::from_pkcs8(der.as_bytes())
                        .map_err(|_| PkiError::KeyGeneration)?,
                ))
            }
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
            SigningKey::Rsa(key) => {
                let encoding = match self.algorithm {
                    SignatureAlgorithm::Sha384Rsa => &aws_signature::RSA_PKCS1_SHA384,
                    SignatureAlgorithm::Sha512Rsa => &aws_signature::RSA_PKCS1_SHA512,
                    _ => &aws_signature::RSA_PKCS1_SHA256,
                };
                let mut signature = vec![0; key.public_modulus_len()];
                key.sign(encoding, &SystemRandom::new(), message, &mut signature)
                    .map_err(|_| PkiError::Signing)?;
                signature
            }
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
    match algorithm {
        SignatureAlgorithm::Sha256Rsa
        | SignatureAlgorithm::Sha384Rsa
        | SignatureAlgorithm::Sha512Rsa => {
            // Keep this API's SPKI-only contract even though AWS-LC also accepts PKCS#1.
            let spki = <spki::SubjectPublicKeyInfoRef<'_> as der::Decode>::from_der(public_key_der)
                .map_err(|_| PkiError::InvalidDer)?;
            if spki.algorithm.oid != der::asn1::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1")
                || spki.algorithm.parameters != Some(der::asn1::AnyRef::NULL)
                || spki.subject_public_key.as_bytes().is_none()
            {
                return Err(PkiError::InvalidDer);
            }
            let parameters = match algorithm {
                SignatureAlgorithm::Sha384Rsa => &aws_signature::RSA_PKCS1_2048_8192_SHA384,
                SignatureAlgorithm::Sha512Rsa => &aws_signature::RSA_PKCS1_2048_8192_SHA512,
                _ => &aws_signature::RSA_PKCS1_2048_8192_SHA256,
            };
            let key = aws_signature::UnparsedPublicKey::new(parameters, public_key_der)
                .parse()
                .map_err(|_| PkiError::InvalidDer)?;
            key.verify_sig(message, signature)
                .map_err(|_| PkiError::SignatureInvalid)
        }
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
mod tests;
