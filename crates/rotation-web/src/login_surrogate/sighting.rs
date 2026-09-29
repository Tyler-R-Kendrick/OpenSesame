//! Finding surrogate-shaped text wherever a page could have put it.
//!
//! The same shape invoke-through recognises (`osr_` and 32 lowercase hex), so
//! a surrogate issued for a login and one issued for an API call are told
//! apart by nothing but the ledger that knows them — and a login surrogate
//! that leaks into an API client is still recognised as a surrogate, never as
//! a credential.

use super::{SURROGATE_HEX_LEN, SURROGATE_MARKER};

/// Every surrogate-shaped run in `haystack`, in order, non-overlapping.
pub(super) fn shaped(haystack: &[u8]) -> Vec<&[u8]> {
    let marker = SURROGATE_MARKER.as_bytes();
    let len = marker.len() + SURROGATE_HEX_LEN;
    let mut found = Vec::new();
    let mut at = 0;
    while at + len <= haystack.len() {
        let candidate = &haystack[at..at + len];
        if candidate.starts_with(marker)
            && candidate[marker.len()..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            found.push(candidate);
            at += len;
        } else {
            at += 1;
        }
    }
    found
}

/// How many surrogate-shaped runs `haystack` holds.
pub(super) fn count(haystack: &[u8]) -> usize {
    shaped(haystack).len()
}

/// `text` with every surrogate-shaped run replaced by a marker.
///
/// A refusal's detail names a site or a host so the owner's notice can say
/// where the surrogate went. A host is chosen by whoever sent the request, and
/// `https://osr_<hex>.attacker.example/` would otherwise carry the surrogate
/// into the notice built to report its theft.
pub(super) fn defang(text: &str) -> String {
    let bytes = text.as_bytes();
    let found = shaped(bytes);
    if found.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    for run in found {
        // Each run is ASCII and was found in order, so the first occurrence in
        // what remains is the one `shaped` reported.
        let run = std::str::from_utf8(run).unwrap_or_default();
        if let Some(at) = rest.find(run) {
            out.push_str(&rest[..at]);
            out.push_str("[surrogate]");
            rest = &rest[at + run.len()..];
        }
    }
    out.push_str(rest);
    out
}

/// Percent-decoding, with `+` as a space when `plus_is_space` (the
/// `application/x-www-form-urlencoded` rule). A `%` not followed by two hex
/// digits is kept as it is, as the WHATWG parser does.
pub(super) fn percent_decode(input: &[u8], plus_is_space: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let byte = input[i];
        let decoded = (byte == b'%')
            .then(|| input.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| Some(hex_value(hex[0])? << 4 | hex_value(hex[1])?));
        if let Some(value) = decoded {
            out.push(value);
            i += 3;
        } else {
            out.push(if plus_is_space && byte == b'+' {
                b' '
            } else {
                byte
            });
            i += 1;
        }
    }
    out
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "osr_0123456789abcdef0123456789abcdef";

    #[test]
    fn finds_every_run_and_nothing_else() {
        let text = format!("a{S}b{S}c osr_0123 OSR_0123456789ABCDEF0123456789ABCDEF");
        assert_eq!(count(text.as_bytes()), 2);
    }

    #[test]
    fn defang_removes_the_surrogate_from_a_detail() {
        let host = format!("{S}.attacker.example");
        assert_eq!(defang(&host), "[surrogate].attacker.example");
        assert_eq!(defang("login.example"), "login.example");
    }

    #[test]
    fn percent_decoding_follows_the_form_rules() {
        assert_eq!(percent_decode(b"a+b%26c%zz%4", true), b"a b&c%zz%4");
        assert_eq!(percent_decode(b"a+b", false), b"a+b");
    }
}
