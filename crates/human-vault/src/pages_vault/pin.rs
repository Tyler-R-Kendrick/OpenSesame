//! The PIN policy (`pinPolicyProblems`, vault-format-v1 §5), checked on the
//! NFKC form before any derivation: 8–12 characters counted as JS counts
//! them (UTF-16 code units), no whitespace, not one repeated character, not a
//! run of consecutive digits.

use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use super::error::{Result, VaultFileError};

const MIN_PIN_LENGTH: usize = 8;
const MAX_PIN_LENGTH: usize = 12;
const ASCENDING: &str = "01234567890123456789";
const DESCENDING: &str = "98765432109876543210";

/// JS `\s`: `WhiteSpace` and `LineTerminator` (ECMA-262), which differs from
/// Rust's `char::is_whitespace` by U+FEFF (JS only) and U+0085 (Rust only).
pub(super) fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

/// Refuse a PIN the writer could never have enrolled.
pub(super) fn check_policy(pin: &str) -> Result<()> {
    let normalized: Zeroizing<String> = Zeroizing::new(pin.nfkc().collect());
    let units = normalized.encode_utf16().count();
    if !(MIN_PIN_LENGTH..=MAX_PIN_LENGTH).contains(&units) {
        return Err(VaultFileError::Rejected("a PIN is 8-12 characters"));
    }
    if normalized.chars().any(is_js_space) {
        return Err(VaultFileError::Rejected("a PIN cannot contain spaces"));
    }
    let mut chars = normalized.chars();
    if let Some(first) = chars.next() {
        if chars.all(|c| c == first) {
            return Err(VaultFileError::Rejected(
                "a PIN cannot be a repeated character",
            ));
        }
    }
    if ASCENDING.contains(normalized.as_str()) || DESCENDING.contains(normalized.as_str()) {
        return Err(VaultFileError::Rejected(
            "a PIN cannot be a sequential run of digits",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check_policy, is_js_space};
    use crate::pages_vault::VaultFileError;

    #[test]
    fn admits_what_the_writer_enrolls() {
        assert_eq!(check_policy("73915286"), Ok(()));
        // Fullwidth digits are the same PIN after NFKC.
        assert_eq!(check_policy("７３９１５２８６"), Ok(()));
    }

    #[test]
    fn refuses_what_the_writer_refuses() {
        for pin in [
            "1234567",
            "1234567890123",
            "7391 5286",
            "11111111",
            "23456789",
            "87654321",
        ] {
            assert!(
                matches!(check_policy(pin), Err(VaultFileError::Rejected(_))),
                "{pin}"
            );
        }
    }

    #[test]
    fn whitespace_is_the_js_set() {
        assert!(is_js_space('\u{feff}'));
        assert!(is_js_space('\u{2028}'));
        assert!(!is_js_space('\u{85}'));
        assert!(!is_js_space('7'));
    }
}
