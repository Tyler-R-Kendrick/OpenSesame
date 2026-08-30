//! Key-pair generation and encoding (ADR 0066 domain model).
//!
//! Secrecy invariant: [`KeyPair`] is the crate's only private-key carrier. It
//! deliberately implements neither `Clone` nor `Serialize`, its `Debug` prints
//! `<redacted>` in place of key material, and the single way to extract the
//! private half — [`KeyPair::private_key_pkcs8_pem`] — hands back a
//! [`Zeroizing<String>`] so the caller cannot accidentally leave a copy on the
//! heap. Callers that only need to *sign* should use [`crate::signer::Signer`]
//! rather than extracting bytes at all.

use rcgen::{
    SignatureAlgorithm as RcgenSignatureAlgorithm, PKCS_ECDSA_P256_SHA256, PKCS_ECDSA_P384_SHA384,
    PKCS_ED25519, PKCS_RSA_SHA256,
};

use rsa::pkcs8::{EncodePrivateKey, LineEnding};
use zeroize::Zeroizing;

use crate::error::PkiError;
use crate::types::KeyAlgorithm;

/// A generated or imported key pair, tagged with the algorithm it belongs to.
///
/// Not `Clone`, not `Serialize`, redacted `Debug` — see the module docs.
pub struct KeyPair {
    algorithm: KeyAlgorithm,
    inner: rcgen::KeyPair,
}

// The omitted field carries private key material. Printing it would defeat the
// crate's secrecy invariant (see the crate docs) and leak keys into logs and
// panic output, so the redaction is deliberate.
#[allow(clippy::missing_fields_in_debug)]
impl std::fmt::Debug for KeyPair {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeyPair")
            .field("algorithm", &self.algorithm)
            .field("private", &"<redacted>")
            .finish()
    }
}

impl KeyPair {
    /// The algorithm this key pair was generated or imported for.
    pub const fn algorithm(&self) -> KeyAlgorithm {
        self.algorithm
    }

    /// The DER-encoded `SubjectPublicKeyInfo` for the public half.
    ///
    /// Public material: safe to log, store unsealed and return to agents.
    pub fn public_key_der(&self) -> Vec<u8> {
        self.inner.public_key_der()
    }

    /// The private key as an unencrypted PKCS#8 PEM document.
    ///
    /// This is the **only** private-material accessor in the crate. The return
    /// value zeroizes on drop; do not copy it into a plain `String`.
    pub fn private_key_pkcs8_pem(&self) -> Zeroizing<String> {
        Zeroizing::new(self.inner.serialize_pem())
    }

    /// The underlying `rcgen` key pair, for certificate construction inside
    /// this crate only.
    pub(crate) const fn rcgen(&self) -> &rcgen::KeyPair {
        &self.inner
    }
}

/// The `rcgen` signature algorithm used for a key of `algorithm`.
const fn rcgen_algorithm(algorithm: KeyAlgorithm) -> &'static RcgenSignatureAlgorithm {
    match algorithm {
        KeyAlgorithm::Rsa2048 | KeyAlgorithm::Rsa4096 => &PKCS_RSA_SHA256,
        KeyAlgorithm::EcdsaP256 => &PKCS_ECDSA_P256_SHA256,
        KeyAlgorithm::EcdsaP384 => &PKCS_ECDSA_P384_SHA384,
        KeyAlgorithm::Ed25519 => &PKCS_ED25519,
    }
}

/// Generates a fresh key pair for `algorithm`.
///
/// RSA keys are generated with the `rsa` crate and re-imported through PKCS#8,
/// because `rcgen`'s default `ring` backend can sign with an RSA key but
/// cannot generate one.
///
/// # Errors
/// Returns [`PkiError::KeyGeneration`] when the underlying backend refuses to
/// produce or re-import a key.
pub fn generate(algorithm: KeyAlgorithm) -> Result<KeyPair, PkiError> {
    let inner = match algorithm {
        KeyAlgorithm::Rsa2048 => generate_rsa(2048)?,
        KeyAlgorithm::Rsa4096 => generate_rsa(4096)?,
        other => rcgen::KeyPair::generate_for(rcgen_algorithm(other))
            .map_err(|_| PkiError::KeyGeneration)?,
    };
    Ok(KeyPair { algorithm, inner })
}

/// Generates an RSA key of `bits` and hands it to `rcgen` as PKCS#8.
fn generate_rsa(bits: usize) -> Result<rcgen::KeyPair, PkiError> {
    let mut rng = rand::thread_rng();
    let private = rsa::RsaPrivateKey::new(&mut rng, bits).map_err(|_| PkiError::KeyGeneration)?;
    let pem = private
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| PkiError::KeyGeneration)?;
    rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(&pem, &PKCS_RSA_SHA256)
        .map_err(|_| PkiError::KeyGeneration)
}

/// Imports an unencrypted PKCS#8 PEM private key as a key pair of
/// `algorithm`.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] when the document is not a PKCS#8 PEM key
/// that matches `algorithm`.
pub fn from_pkcs8_pem(pem: &str, algorithm: KeyAlgorithm) -> Result<KeyPair, PkiError> {
    let inner = rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(pem, rcgen_algorithm(algorithm))
        .map_err(|_| PkiError::InvalidPem)?;
    Ok(KeyPair { algorithm, inner })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The algorithms cheap enough to exercise in every test; RSA generation
    /// is covered separately because a 4096-bit keygen in a debug build is
    /// measured in seconds, not milliseconds.
    pub(crate) const FAST_ALGORITHMS: [KeyAlgorithm; 3] = [
        KeyAlgorithm::EcdsaP256,
        KeyAlgorithm::EcdsaP384,
        KeyAlgorithm::Ed25519,
    ];

    #[test]
    fn generated_keys_round_trip_through_pkcs8_pem() {
        for algorithm in FAST_ALGORITHMS {
            let key = generate(algorithm).unwrap();
            assert_eq!(key.algorithm(), algorithm);
            let pem = key.private_key_pkcs8_pem();
            assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----"));
            let reimported = from_pkcs8_pem(&pem, algorithm).unwrap();
            assert_eq!(reimported.public_key_der(), key.public_key_der());
        }
    }

    #[test]
    fn rsa_keys_generate_and_round_trip() {
        let key = generate(KeyAlgorithm::Rsa2048).unwrap();
        assert_eq!(key.algorithm(), KeyAlgorithm::Rsa2048);
        let pem = key.private_key_pkcs8_pem();
        let reimported = from_pkcs8_pem(&pem, KeyAlgorithm::Rsa2048).unwrap();
        assert_eq!(reimported.public_key_der(), key.public_key_der());
    }

    #[test]
    fn debug_never_renders_private_material() {
        let key = generate(KeyAlgorithm::Ed25519).unwrap();
        let rendered = format!("{key:?}");
        assert_eq!(
            rendered,
            "KeyPair { algorithm: Ed25519, private: \"<redacted>\" }"
        );
        let pem = key.private_key_pkcs8_pem();
        let body: String = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        assert!(!body.is_empty());
        assert!(!rendered.contains(&body));
    }

    #[test]
    fn importing_a_key_under_the_wrong_algorithm_fails() {
        let key = generate(KeyAlgorithm::Ed25519).unwrap();
        let pem = key.private_key_pkcs8_pem();
        assert_eq!(
            from_pkcs8_pem(&pem, KeyAlgorithm::EcdsaP256).unwrap_err(),
            PkiError::InvalidPem
        );
    }

    #[test]
    fn adversarial_garbage_pem_is_rejected_without_panicking() {
        for hostile in [
            "",
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----\nnot base64!!\n-----END PRIVATE KEY-----\n",
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
            "\0\0\0",
        ] {
            assert!(from_pkcs8_pem(hostile, KeyAlgorithm::Ed25519).is_err());
        }
    }

    #[test]
    fn distinct_generations_produce_distinct_keys() {
        let first = generate(KeyAlgorithm::EcdsaP256).unwrap();
        let second = generate(KeyAlgorithm::EcdsaP256).unwrap();
        assert_ne!(first.public_key_der(), second.public_key_der());
    }
}
