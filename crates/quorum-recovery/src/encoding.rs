//! base64url without padding, the encoding every quorum packet uses
//! (`packages/app-core/src/lib/quorum/bytes.ts`).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

/// The text was not base64url without padding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not base64url")]
pub struct NotBase64url;

/// Encode `bytes` as unpadded base64url.
#[must_use]
pub fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode unpadded base64url; padding, other alphabets and stray bits are refused.
///
/// # Errors
/// [`NotBase64url`] when `text` is not canonical unpadded base64url.
pub fn b64url_decode(text: &str) -> Result<Vec<u8>, NotBase64url> {
    URL_SAFE_NO_PAD.decode(text).map_err(|_| NotBase64url)
}

/// True when `text` is non-empty and only uses the base64url alphabet, which
/// is what the TypeScript schemas' `B64URL` regex checks.
#[must_use]
pub fn is_b64url_charset(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::{b64url_decode, b64url_encode, is_b64url_charset};

    #[test]
    fn round_trips_without_padding() {
        for len in 0..9u8 {
            let bytes: Vec<u8> = (0..len).map(|i| 250 - i).collect();
            let text = b64url_encode(&bytes);
            assert!(!text.contains('='));
            assert_eq!(b64url_decode(&text).unwrap(), bytes);
        }
    }

    #[test]
    fn refuses_padding_and_the_standard_alphabet() {
        assert!(b64url_decode("AQ==").is_err());
        assert!(b64url_decode("a+b/").is_err());
        assert!(is_b64url_charset("a-b_9"));
        assert!(!is_b64url_charset(""));
        assert!(!is_b64url_charset("a+b"));
    }
}
