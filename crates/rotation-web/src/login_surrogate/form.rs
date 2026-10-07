//! `application/x-www-form-urlencoded`: parse, place, re-encode.
//!
//! The body is split into pairs and every key and value is decoded the way
//! the server will decode it (`+` as a space, then percent-decoding) before
//! anything is looked for, so a surrogate the page percent-encoded is still
//! found where it is. The credential is then written into the declared pair
//! with the form serializer's own encoding — never spliced in raw — so a
//! secret holding `&`, `=`, `%` or `+` reaches the server byte for byte
//! instead of being cut into extra pairs (ADR 0076 §6's mangling). Every other
//! pair is copied through exactly as the page wrote it.

use zeroize::Zeroizing;

use super::outcome::{Refusal, RefusalCode};
use super::sighting::{count, percent_decode};

/// Where the declared field was found: its pair's index and the raw key
/// text, which is kept rather than re-encoded.
struct Site<'a> {
    index: usize,
    raw_key: &'a [u8],
    exact: bool,
}

/// `body` with the credential in place of the surrogate at `field`.
pub(super) fn substitute(
    body: &[u8],
    field: &str,
    surrogate: &str,
    credential: &str,
) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    let pairs: Vec<&[u8]> = body.split(|b| *b == b'&').collect();
    let mut in_keys = 0;
    let mut total = 0;
    let mut sites: Vec<Site<'_>> = Vec::new();
    for (index, raw) in pairs.iter().enumerate() {
        if raw.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = split_pair(raw);
        let key = percent_decode(raw_key, true);
        let value = percent_decode(raw_value, true);
        in_keys += count(&key);
        total += count(&key) + count(&value);
        if key == field.as_bytes() {
            sites.push(Site {
                index,
                raw_key,
                exact: value == surrogate.as_bytes(),
            });
        }
    }
    if total == 0 {
        return Err(Refusal::new(RefusalCode::Absent, "form"));
    }
    if in_keys > 0 {
        return Err(Refusal::new(RefusalCode::Misplaced, "form-key"));
    }
    let site = match sites.as_slice() {
        [site] => site,
        [] => return Err(Refusal::new(RefusalCode::Misplaced, "form-field")),
        _ => return Err(Refusal::new(RefusalCode::Misplaced, "form-field-repeated")),
    };
    if !site.exact || total != 1 {
        return Err(Refusal::new(RefusalCode::Misplaced, "form-field"));
    }
    // Reserved up front so the buffer never reallocates: a reallocation would
    // leave a copy of the credential in memory nobody zeroes.
    let mut out = Zeroizing::new(Vec::with_capacity(body.len() + credential.len() * 3 + 1));
    for (index, raw) in pairs.iter().enumerate() {
        if index > 0 {
            out.push(b'&');
        }
        if index == site.index {
            out.extend_from_slice(site.raw_key);
            out.push(b'=');
            form_encode_into(credential.as_bytes(), &mut out);
        } else {
            out.extend_from_slice(raw);
        }
    }
    Ok(out)
}

/// Whether any key or value in `body`, decoded, holds a surrogate.
pub(super) fn carries(body: &[u8]) -> bool {
    body.split(|b| *b == b'&').any(|raw| {
        let (key, value) = split_pair(raw);
        count(&percent_decode(key, true)) + count(&percent_decode(value, true)) > 0
    })
}

fn split_pair(raw: &[u8]) -> (&[u8], &[u8]) {
    match raw.iter().position(|b| *b == b'=') {
        Some(at) => (&raw[..at], &raw[at + 1..]),
        None => (raw, &[]),
    }
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// The WHATWG `application/x-www-form-urlencoded` byte serializer: ASCII
/// alphanumerics and `*-._` stay, a space becomes `+`, everything else is
/// `%XX`.
pub(super) fn form_encode_into(bytes: &[u8], out: &mut Vec<u8>) {
    for &byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'*' | b'-' | b'.' | b'_') {
            out.push(byte);
        } else if byte == b' ' {
            out.push(b'+');
        } else {
            out.push(b'%');
            out.push(HEX[usize::from(byte >> 4)]);
            out.push(HEX[usize::from(byte & 0x0f)]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "osr_0123456789abcdef0123456789abcdef";

    #[test]
    fn other_pairs_pass_through_byte_for_byte() {
        let body = format!("user=a%40b.example&&password={S}&remember");
        let out = substitute(body.as_bytes(), "password", S, "p w").unwrap();
        assert_eq!(&out[..], b"user=a%40b.example&&password=p+w&remember");
    }

    #[test]
    fn a_percent_encoded_surrogate_is_still_found_in_its_field() {
        let body = "password=osr%5F0123456789abcdef0123456789abcdef"; // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
        let out = substitute(body.as_bytes(), "password", S, "x").unwrap();
        assert_eq!(&out[..], b"password=x");
    }

    #[test]
    fn a_percent_encoded_field_name_is_the_same_field() {
        let body = format!("pass%77ord={S}");
        let out = substitute(body.as_bytes(), "password", S, "x").unwrap();
        assert_eq!(&out[..], b"pass%77ord=x");
    }
}
