//! The three ways a Pages vault file fails to open. Every reason is a fixed
//! string: nothing read from the file, and never a key or a value, is echoed
//! back in an error.

use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum VaultFileError {
    /// The file is a vault file, but a part of it is damaged, foreign or
    /// edited: the header, the KDF parameters, a seal or the body
    /// (vault-format-v1 §3, §6). Raised before any derivation whenever the
    /// problem is visible without a key.
    #[error("the vault file could not be read: {0}")]
    Corrupt(&'static str),
    /// The password, PIN or passkey did not unlock the vault key: the AES-GCM
    /// tag over the wrap failed (vault-format-v1 §4).
    #[error("that credential did not unlock the vault")]
    WrongPassword,
    /// A rule refused the file or the input before any cryptography: an
    /// envelope rule of vault-format-v1 §7, or the PIN policy (§5).
    #[error("refused: {0}")]
    Rejected(&'static str),
}

pub type Result<T> = std::result::Result<T, VaultFileError>;
