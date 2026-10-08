//! The PIN policy (`pinPolicyProblems`, vault-format-v1 §5), checked on the
//! NFKC form before any derivation: 8–64 characters counted as JS counts
//! them (UTF-16 code units), no whitespace, not one repeated character, not a
//! run of consecutive digits. Duress stays 8–12 digits (ADR 0155).

use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use super::error::{Result, VaultFileError};

const MIN_PIN_LENGTH: usize = 8;
const MAX_PIN_LENGTH: usize = 64;
const PIN_LENGTH_ERROR: &str = "a PIN is 8-64 characters";

/// A wrapping digit run long enough to contain a PIN of `MAX_PIN_LENGTH`.
fn digit_run(start: u8, step: i8) -> String {
    let mut digit = start;
    let mut out = String::with_capacity(MAX_PIN_LENGTH + 10);
    while out.len() < MAX_PIN_LENGTH + 10 {
        out.push(char::from(b'0' + digit));
        digit = (digit as i8 + step).rem_euclid(10) as u8;
    }
    out
}

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
        return Err(VaultFileError::Rejected(PIN_LENGTH_ERROR));
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
    if digit_run(0, 1).contains(normalized.as_str())
        || digit_run(9, -1).contains(normalized.as_str())
    {
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
        // Past the old 12-character cap, still inside 64.
        assert_eq!(check_policy("7391528647391"), Ok(()));
        assert_eq!(check_policy(&"ab".repeat(32)), Ok(()));
    }

    #[test]
    fn refuses_what_the_writer_refuses() {
        let past_cap = "ab".repeat(33);
        let sequential = "0123456789".repeat(6) + "0123";
        for pin in [
            "1234567",
            "1234567890123",
            past_cap.as_str(),
            sequential.as_str(),
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
