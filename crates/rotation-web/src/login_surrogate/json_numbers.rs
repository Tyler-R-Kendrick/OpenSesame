//! Numbers in a login body must survive re-serialization unchanged.
//!
//! The body is parsed and written back, and `serde_json` keeps a number as an
//! `i64`, `u64` or `f64`. A lexeme outside that (an integer past `u64`, `-0`,
//! `1e2`) would reach the server as a different number: a login that binds a
//! nonce or an identifier could then fail, or bind another one. So a body
//! holding any number whose canonical spelling is not its own is refused as
//! unsupported, and the login falls back to CDP fill; nothing is rounded.

/// Whether every number token in `body` is spelled exactly as `serde_json`
/// would write it back. Strings are skipped, escapes included.
pub(super) fn round_trip(body: &[u8]) -> bool {
    let mut at = 0;
    while at < body.len() {
        match body[at] {
            b'"' => at = end_of_string(body, at),
            b'-' | b'0'..=b'9' => {
                let end = body[at..]
                    .iter()
                    .position(|b| !matches!(b, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                    .map_or(body.len(), |n| at + n);
                if !canonical(&body[at..end]) {
                    return false;
                }
                at = end;
            }
            _ => at += 1,
        }
    }
    true
}

/// The index just past the string that opens at `start`.
fn end_of_string(body: &[u8], start: usize) -> usize {
    let mut at = start + 1;
    while at < body.len() {
        match body[at] {
            b'\\' => at += 2,
            b'"' => return at + 1,
            _ => at += 1,
        }
    }
    body.len()
}

fn canonical(token: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(token) else {
        return false;
    };
    if text.contains(['.', 'e', 'E']) {
        return text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .is_some_and(|number| number.to_string() == text);
    }
    if let Ok(value) = text.parse::<i64>() {
        return value.to_string() == text;
    }
    text.parse::<u64>()
        .is_ok_and(|value| value.to_string() == text)
}

#[cfg(test)]
mod tests {
    use super::round_trip;

    #[test]
    fn canonical_numbers_pass() {
        for body in [
            r#"{"a":0,"b":-7,"c":18446744073709551615,"d":1.5,"e":100.0,"f":-0.25}"#,
            r#"{"a":[1,2,3],"b":"1e2 and 007 are just text","c":true,"d":null}"#,
            r#"{"s":"a \" quote 12345678901234567890123 inside"}"#,
        ] {
            assert!(round_trip(body.as_bytes()), "{body}");
        }
    }

    #[test]
    fn a_number_that_would_change_is_caught() {
        for body in [
            r#"{"n":123456789012345678901234567890}"#,
            r#"{"n":-0}"#,
            r#"{"n":1e2}"#,
            r#"{"n":2E3}"#,
            r#"{"n":1.50}"#,
            r#"{"n":[0.10]}"#,
            r#"{"n":-9223372036854775809}"#,
        ] {
            assert!(!round_trip(body.as_bytes()), "{body}");
        }
    }
}
