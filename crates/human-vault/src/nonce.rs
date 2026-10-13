use crate::VaultCryptoError;
use base64::{engine::general_purpose::STANDARD, Engine};

/// Decode a stored nonce, refusing any length `XChaCha20` would panic on.
pub(crate) fn decode_nonce(encoded: &str) -> Result<[u8; 24], VaultCryptoError> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| VaultCryptoError::Aead)?;
    let nonce: [u8; 24] = bytes
        .try_into()
        .map_err(|_| VaultCryptoError::NonceLength)?;
    Ok(nonce)
}
