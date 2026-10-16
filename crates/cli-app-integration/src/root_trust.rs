//! Enrolled daemon root trust key: `SPKI` fingerprint and enrollment epoch.
//!
//! The daemon persists a [`RootTrustRecord`] in its state directory and calls
//! [`crate::CliAppIntegrationPairings::mark_root_key_enrolled`] on startup.
//! This module is the record. It does not touch the disk.

use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of a root trust public key's `SPKI` `DER` bytes.
#[must_use]
pub fn fingerprint_of_spki(spki_der: &[u8]) -> String {
    hex::encode(Sha256::digest(spki_der))
}

/// Why a root trust record was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RootTrustError {
    /// Fingerprint was not 64 lowercase hex characters, or the epoch was zero.
    #[error(
        "root trust record needs a 64-character lowercase hex SPKI fingerprint and a positive enrollment epoch"
    )]
    Invalid,
}

/// What the daemon trust store keeps after the root trust key is enrolled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootTrustRecord {
    spki_fingerprint: String,
    enrollment_epoch: u64,
}

impl RootTrustRecord {
    /// Build a record the trust store can persist.
    ///
    /// # Errors
    ///
    /// Returns [`RootTrustError::Invalid`] when `spki_fingerprint` is not 64
    /// lowercase hex characters or `enrollment_epoch` is zero.
    pub fn new(
        spki_fingerprint: impl Into<String>,
        enrollment_epoch: u64,
    ) -> Result<Self, RootTrustError> {
        let spki_fingerprint = spki_fingerprint.into();
        if enrollment_epoch == 0 || !is_lowercase_hex_fingerprint(&spki_fingerprint) {
            return Err(RootTrustError::Invalid);
        }
        Ok(Self {
            spki_fingerprint,
            enrollment_epoch,
        })
    }

    /// Lowercase hex SHA-256 of the enrolled root trust `SPKI`.
    #[must_use]
    pub fn spki_fingerprint(&self) -> &str {
        &self.spki_fingerprint
    }

    /// Monotonic enrollment generation. The first enrollment is epoch 1.
    #[must_use]
    pub fn enrollment_epoch(&self) -> u64 {
        self.enrollment_epoch
    }
}

fn is_lowercase_hex_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::{fingerprint_of_spki, RootTrustError, RootTrustRecord};

    #[test]
    fn fingerprint_is_sha256_hex() {
        assert_eq!(
            fingerprint_of_spki(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn record_accepts_a_canonical_fingerprint_and_positive_epoch() {
        let fingerprint = fingerprint_of_spki(b"root-trust-spki");
        let record = RootTrustRecord::new(fingerprint.clone(), 1).expect("record");
        assert_eq!(record.spki_fingerprint(), fingerprint);
        assert_eq!(record.enrollment_epoch(), 1);
    }

    #[test]
    fn record_rejects_bad_fingerprint_or_zero_epoch() {
        let good = fingerprint_of_spki(b"root-trust-spki");
        assert_eq!(
            RootTrustRecord::new(good.clone(), 0).unwrap_err(),
            RootTrustError::Invalid
        );
        assert!(RootTrustRecord::new(good.to_ascii_uppercase(), 1).is_err());
        assert!(RootTrustRecord::new("ab".repeat(31), 1).is_err());
        assert!(RootTrustRecord::new(format!("{good}ab"), 1).is_err());
    }
}
