//! Base64 as the writer's `atob` reads it (vault-format-v1 §1): the standard
//! alphabet, padding optional, ASCII whitespace ignored — the WHATWG
//! forgiving-base64 decode.

use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine,
};

const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// Decode a `…B64` field, or `None` when it is not base64.
pub(super) fn decode(value: &str) -> Option<Vec<u8>> {
    let compact: String = value
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r'))
        .collect();
    FORGIVING.decode(compact).ok()
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn reads_what_atob_reads() {
        assert_eq!(decode("AAECAw==").unwrap(), [0, 1, 2, 3]);
        assert_eq!(decode("AAECAw").unwrap(), [0, 1, 2, 3]);
        assert_eq!(decode(" AAEC\nAw== ").unwrap(), [0, 1, 2, 3]);
        assert!(decode("AA-_").is_none());
        assert!(decode("A").is_none());
    }
}
