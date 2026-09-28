//! Second sign-in steps (ADR 0148): authenticator codes, the recovery code,
//! "remember this device", and the personal API key.
//!
//! An authenticator is RFC 6238 TOTP — SHA-1, six digits, thirty seconds —
//! computed by `opensesame-authenticator-core`, the one OTP implementation
//! the product has. A code is accepted for the step before, at, or after the
//! server's clock, and each step only once.

use data_encoding::BASE32_NOPAD;
use opensesame_authenticator_core::{parse_otpauth, totp_code};
use rand::RngCore as _;
use subtle::ConstantTimeEq as _;

/// Bitwarden's provider numbers this server serves.
pub const AUTHENTICATOR: i64 = 0;
/// "Remember this device": the token a device kept from an earlier sign-in.
pub const REMEMBER: i64 = 5;
/// Signing in with the recovery code, which turns two-step login off.
pub const RECOVERY_CODE: i64 = 8;

const PERIOD: i64 = 30;
/// Steps either side of the server's clock a code may come from.
const DRIFT: i64 = 1;

fn random(len: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

/// A fresh authenticator key: 160 bits, base32, as authenticator apps read it.
#[must_use]
pub fn new_authenticator_key() -> String {
    BASE32_NOPAD.encode(&random(20))
}

/// A key as a person or client may type it: spaces and case do not matter.
#[must_use]
pub fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .collect::<String>()
        .to_ascii_uppercase()
}

/// Whether `key` is a base32 key an authenticator app can hold.
#[must_use]
pub fn is_authenticator_key(key: &str) -> bool {
    let key = normalize_key(key);
    (16..=128).contains(&key.len())
        && BASE32_NOPAD
            .decode(key.as_bytes())
            .is_ok_and(|bytes| bytes.len() >= 10)
}

/// The time step `code` belongs to, if it is right for `key` near `now`.
#[must_use]
pub fn code_step(key: &str, code: &str, now: i64) -> Option<i64> {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let uri = parse_otpauth(&format!(
        "otpauth://totp/OpenSesame?secret={}",
        normalize_key(key)
    ))
    .ok()?;
    let here = now.div_euclid(PERIOD);
    (here - DRIFT..=here + DRIFT).find(|step| {
        u64::try_from(step * PERIOD)
            .ok()
            .and_then(|at| totp_code(&uri, at).ok())
            .is_some_and(|expected| bool::from(expected.as_bytes().ct_eq(code.as_bytes())))
    })
}

/// A fresh recovery code: 32 base32 characters, as Bitwarden shows one.
#[must_use]
pub fn new_recovery_code() -> String {
    BASE32_NOPAD.encode(&random(20))
}

/// Whether a typed recovery code is the stored one, whatever its spacing.
#[must_use]
pub fn recovery_matches(stored: &str, typed: &str) -> bool {
    let typed = normalize_key(typed);
    bool::from(stored.as_bytes().ct_eq(typed.as_bytes()))
}

/// A fresh personal API key: 30 letters and digits.
#[must_use]
pub fn new_api_key() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    random(30)
        .into_iter()
        .map(|b| char::from(ALPHABET[usize::from(b) % ALPHABET.len()]))
        .collect()
}

/// Whether a presented API key is the account's.
#[must_use]
pub fn api_key_matches(stored: &str, presented: &str) -> bool {
    bool::from(stored.as_bytes().ct_eq(presented.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238's SHA-1 test key, base32.
    const RFC_KEY: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn codes_match_rfc_6238_within_one_step_either_side() {
        // RFC 6238 Appendix B: T = 59 → 94287082; six digits → 287082.
        assert_eq!(code_step(RFC_KEY, "287082", 59), Some(1));
        assert_eq!(code_step(RFC_KEY, "287 082", 59 + 30), Some(1));
        assert_eq!(code_step(RFC_KEY, "287082", 59 + 90), None);
        assert_eq!(code_step(RFC_KEY, "000000", 59), None);
        assert_eq!(code_step(RFC_KEY, "28708", 59), None);
        assert_eq!(
            code_step(&RFC_KEY.to_ascii_lowercase(), "287082", 59),
            Some(1)
        );
    }

    #[test]
    fn fresh_keys_codes_and_api_keys_have_their_shapes() {
        let key = new_authenticator_key();
        assert_eq!(key.len(), 32);
        assert!(is_authenticator_key(&key));
        assert!(!is_authenticator_key("not base32!"));
        assert!(!is_authenticator_key("AAAA"));
        let code = new_recovery_code();
        assert!(recovery_matches(&code, &code.to_ascii_lowercase()));
        assert!(!recovery_matches(&code, "WRONG"));
        let api = new_api_key();
        assert_eq!(api.len(), 30);
        assert!(api.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert!(api_key_matches(&api, &api));
        assert!(!api_key_matches(&api, &new_api_key()));
    }
}
