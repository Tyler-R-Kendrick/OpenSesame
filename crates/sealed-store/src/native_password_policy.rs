//! Default browser12/Fair heuristic for newly issued native passwords only.
//! Native issuance requires valid UTF8 and at most4096 bytes; browser strings are broader.
//! This follows the default estimator, not an injected browser strength seam.
//! This is a conservative strength heuristic, never proof of entropy or owner authentication.
use crate::StoreError;
use std::collections::BTreeSet;
fn refused() -> StoreError {
    StoreError::Other(
        "new master password must have at least12 characters and Fair strength".into(),
    )
}
/// Validate new native master-password input against the default browser12/Fair policy.
/// Existing unlock/recovery inputs and retired matching do not acquire a new length restriction.
/// # Errors
/// Refuses invalidUTF8, oversized input, short passwords and the default weak estimate.
pub fn assert_native_new_password_policy(password: &[u8]) -> Result<(), StoreError> {
    if password.len() > 4096 {
        return Err(refused());
    }
    let text = std::str::from_utf8(password).map_err(|_| refused())?;
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() < 12 {
        return Err(refused());
    }
    let mut alphabet = 0u32;
    if text.chars().any(|c| c.is_ascii_lowercase()) {
        alphabet += 26;
    }
    if text.chars().any(|c| c.is_ascii_uppercase()) {
        alphabet += 26;
    }
    if text.chars().any(|c| c.is_ascii_digit()) {
        alphabet += 10;
    }
    if text.chars().any(|c| !c.is_ascii_alphanumeric()) {
        alphabet += 33;
    }
    let unique =
        u32::try_from(text.chars().collect::<BTreeSet<_>>().len()).map_err(|_| refused())?;
    let length = u32::try_from(units.len()).map_err(|_| refused())?;
    // Checked counts are bounded by the 4096-byte input limit; no lossy usize cast.
    // UTF16length / codepointSet matches the browser's string.length / new Set(string).
    let mut bits = f64::from(length)
        * f64::from(alphabet.max(2)).log2()
        * (f64::from(unique) / f64::from(length));
    let lower = text.to_lowercase();
    for sequence in [
        "abcdefghijklmnopqrstuvwxyz",
        "01234567890",
        "qwertyuiop",
        "asdfghjkl",
    ] {
        if sequence
            .as_bytes()
            .windows(3)
            .any(|run| lower.contains(std::str::from_utf8(run).unwrap_or("")))
        {
            bits -= 8.0;
        }
    }
    if units
        .iter()
        .all(|c| (u16::from(b'0')..=u16::from(b'9')).contains(c))
    {
        bits *= 0.55;
    }
    if units.windows(3).any(|run| {
        run[0] == run[1] && run[1] == run[2] && ![10, 13, 0x2028, 0x2029].contains(&run[0])
    }) {
        bits -= 6.0;
    }
    // Every listed browser COMMON password has fewer than12UTF16units and already refused.
    if bits.round().max(0.0) < 48.0 {
        return Err(refused());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_floor_refuses_short_repeat_and_keyboard_runs_but_accepts_good_master_inputs() {
        for password in [
            "p",
            "short",
            "aaaaaaaaaaaa",
            "123456789012",
            "abcabcabcabc",
            "abcdefghijkl",
            "qwertyqwerty",
        ] {
            assert!(
                assert_native_new_password_policy(password.as_bytes()).is_err(),
                "{password}"
            );
        }
        for password in [
            "actual newly chosen whole root password",
            "original actual native owner password",
            "N8!qT4@vR7#pL2",
        ] {
            assert!(assert_native_new_password_policy(password.as_bytes()).is_ok());
        }
        assert!(assert_native_new_password_policy(&[0xff; 12]).is_err());
        assert!(assert_native_new_password_policy(&vec![b'x'; 4097]).is_err());
    }
}
