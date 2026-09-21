//! Typed failures for root-protection parse/crypto/lifecycle (C04 / KP-03).

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtectionError {
    #[error("unsupported root-protection schema version {0}")]
    UnsupportedVersion(u32),
    #[error("unknown critical field in root-protection document")]
    UnknownCriticalField,
    #[error("duplicate protector id")]
    DuplicateProtectorId,
    #[error("root-protection document exceeds size bound")]
    OversizedManifest,
    #[error("protection record exceeds size bound")]
    OversizedRecord,
    #[error("too many protection records")]
    TooManyRecords,
    #[error("malformed root-protection encoding: {0}")]
    MalformedEncoding(String),
    #[error("legacy .opensesame-key password wrapper is malformed: {0}")]
    MalformedLegacy(String),
    #[error("invalid key length")]
    InvalidKeyLength,
    #[error("protection context mismatch")]
    ContextMismatch,
    #[error("manifest authentication failed")]
    ManifestAuthFailed,
    #[error("capsule authentication failed")]
    CapsuleAuthFailed,
    #[error("password wrapper KDF parameters out of range")]
    KdfBounds,
    #[error("protector not found")]
    ProtectorNotFound,
    #[error("last verified unlock path would be removed")]
    LastVerifiedPath,
    #[error("root-protection feature unavailable: {0}")]
    Unavailable(String),
    #[error("unsupported runtime for this protector")]
    UnsupportedRuntime,
    #[error("requires hardware presence")]
    RequiresHardware,
    #[error("crypto failure")]
    Crypto,
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for ProtectionError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<crate::VaultCryptoError> for ProtectionError {
    fn from(value: crate::VaultCryptoError) -> Self {
        match value {
            crate::VaultCryptoError::KdfParamsOutOfRange => Self::KdfBounds,
            crate::VaultCryptoError::KeyLength | crate::VaultCryptoError::NonceLength => {
                Self::InvalidKeyLength
            }
            crate::VaultCryptoError::UnsupportedVersion(v) => Self::UnsupportedVersion(v),
            crate::VaultCryptoError::Aead | crate::VaultCryptoError::AdMismatch => Self::Crypto,
            crate::VaultCryptoError::Kdf => Self::Crypto,
        }
    }
}
