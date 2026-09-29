//! Reflection scrub: the credential never rides back in a response.
//!
//! The broker places the token upstream and returns the upstream's answer.
//! An upstream that echoes what it was sent — a debug or echo route, an error
//! that quotes the rejected token, a webhook preview — would turn that answer
//! into an oracle: the caller could not read the credential from the broker,
//! but could read it back from the host the broker is allowed to reach. That
//! is the reflection attack every egress-substitution design shares (ADR 0150
//! §4), and it is closed here rather than per provider.
//!
//! What is matched: the raw token; the token under one layer of text
//! encoding however the encoder spelled each character (`dialect.rs`) —
//! percent-encoded in either hex case with any subset of bytes escaped and
//! `+` for a space, JSON-escaped with any mix of short and `\u` escapes, and
//! HTML-escaped with any mix of named, decimal and hex references; and its
//! base64 body, standard and URL-safe, at each of the three byte alignments
//! it can sit at inside a larger blob (`Basic base64(user:token)` puts it at
//! alignment 2). The base64 needle is the run of characters that depends on
//! token bytes alone, so it matches wherever the token was encoded, whatever
//! surrounded it. What is not matched: two layers of encoding at once, or any
//! other transform — a hash, a reversal, an encryption. Those do not return
//! the credential; they return something derived from it, which is outside
//! what a scrub can promise.

mod dialect;

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use bytes::Bytes;
use zeroize::Zeroizing;

/// What replaces a reflected credential.
pub(crate) const REDACTED: &[u8] = b"[redacted:credential]";

/// Base64 needles shorter than this are not searched for: a short run of
/// base64 characters matches ordinary text by chance.
const MIN_ENCODED_NEEDLE: usize = 12;

/// Every byte form of one credential the scrub looks for. Held zeroized: the
/// forms are the credential by another name.
pub(crate) struct Needles {
    /// The credential itself, which each text dialect matches a unit at a time.
    token: Zeroizing<String>,
    forms: Vec<Zeroizing<Vec<u8>>>,
}

impl Needles {
    pub(crate) fn new(token: &str) -> Self {
        let held = Zeroizing::new(token.to_owned());
        let mut forms: Vec<Zeroizing<Vec<u8>>> = Vec::new();
        if token.is_empty() {
            return Self { token: held, forms };
        }
        forms.push(Zeroizing::new(token.as_bytes().to_vec()));
        let encoded = (0..3).flat_map(|alignment| {
            [false, true]
                .into_iter()
                .filter_map(move |url_safe| aligned_base64(token.as_bytes(), alignment, url_safe))
        });
        for form in encoded {
            if !forms
                .iter()
                .any(|known| known.as_slice() == form.as_slice())
            {
                forms.push(form);
            }
        }
        // Longest first, so a form that contains another is replaced whole.
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        Self { token: held, forms }
    }

    /// `bytes` with every form of the credential replaced, and whether any was
    /// found. Returns the input untouched when nothing matched.
    pub(crate) fn scrub(&self, bytes: Bytes) -> (Bytes, bool) {
        let mut current: Option<Vec<u8>> = None;
        for form in &self.forms {
            let haystack = current.as_deref().unwrap_or(&bytes);
            if let Some(replaced) = replace_all(haystack, form) {
                current = Some(replaced);
            }
        }
        for each in dialect::ALL {
            let haystack = current.as_deref().unwrap_or(&bytes);
            if let Some(replaced) = dialect::replace(each, haystack, &self.token, REDACTED) {
                current = Some(replaced);
            }
        }
        match current {
            Some(scrubbed) => (Bytes::from(scrubbed), true),
            None => (bytes, false),
        }
    }

    /// A header value with every form replaced, and whether any was found.
    pub(crate) fn scrub_str(&self, value: String) -> (String, bool) {
        let (scrubbed, hit) = self.scrub(Bytes::from(value.clone()));
        if !hit {
            return (value, false);
        }
        // REDACTED is ASCII and every replaced form was a byte run of valid
        // UTF-8 matched whole, so the result stays UTF-8; fall back to the
        // bare marker rather than trust that silently.
        let text = String::from_utf8(scrubbed.to_vec())
            .unwrap_or_else(|_| String::from_utf8_lossy(REDACTED).into_owned());
        (text, true)
    }
}

/// The base64 characters that depend on `token` alone when it sits `alignment`
/// bytes into a 3-byte group. The leading group (shared with whatever precedes
/// the token) and the trailing partial group (shared with whatever follows) are
/// dropped. `None` when what remains is too short to search for safely.
fn aligned_base64(token: &[u8], alignment: usize, url_safe: bool) -> Option<Zeroizing<Vec<u8>>> {
    let mut padded = Zeroizing::new(vec![0u8; alignment]);
    padded.extend_from_slice(token);
    let encoded = Zeroizing::new(if url_safe {
        URL_SAFE_NO_PAD.encode(padded.as_slice())
    } else {
        STANDARD_NO_PAD.encode(padded.as_slice())
    });
    let skip = if alignment == 0 { 0 } else { 4 };
    let whole_groups = padded.len() / 3;
    let end = whole_groups * 4;
    if end <= skip || end - skip < MIN_ENCODED_NEEDLE {
        return None;
    }
    Some(Zeroizing::new(encoded.as_bytes()[skip..end].to_vec()))
}

/// `haystack` with every non-overlapping `needle` replaced by [`REDACTED`], or
/// `None` when the needle does not occur.
fn replace_all(haystack: &[u8], needle: &[u8]) -> Option<Vec<u8>> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut out: Option<Vec<u8>> = None;
    let mut copied = 0;
    let mut at = 0;
    while at + needle.len() <= haystack.len() {
        if &haystack[at..at + needle.len()] == needle {
            let buf = out.get_or_insert_with(|| Vec::with_capacity(haystack.len()));
            buf.extend_from_slice(&haystack[copied..at]);
            buf.extend_from_slice(REDACTED);
            at += needle.len();
            copied = at;
        } else {
            at += 1;
        }
    }
    let mut buf = out?;
    buf.extend_from_slice(&haystack[copied..]);
    Some(buf)
}

#[cfg(test)]
#[path = "scrub_dialect_tests.rs"]
mod dialect_tests;

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";

    fn scrubbed(input: &str) -> (String, bool) {
        let (out, hit) = Needles::new(TOKEN).scrub(Bytes::from(input.to_string()));
        (String::from_utf8(out.to_vec()).unwrap(), hit)
    }

    #[test]
    fn raw_token_is_replaced_everywhere() {
        let (out, hit) = scrubbed(&format!("a {TOKEN} b {TOKEN}"));
        assert!(hit);
        assert_eq!(out, "a [redacted:credential] b [redacted:credential]");
    }

    #[test]
    fn base64_at_every_alignment_and_both_alphabets_is_replaced() {
        for prefix in ["", "x", "x:", "user:"] {
            let blob = format!("{prefix}{TOKEN}\n");
            for encoded in [
                base64::engine::general_purpose::STANDARD.encode(&blob),
                base64::engine::general_purpose::URL_SAFE.encode(&blob),
            ] {
                let (out, hit) = scrubbed(&format!("Basic {encoded}"));
                assert!(hit, "prefix {prefix:?}: {encoded}");
                // Nothing long enough to rebuild the token survives: at most
                // the edge groups shared with the prefix and suffix remain.
                let kept = out
                    .trim_start_matches("Basic ")
                    .replace("[redacted:credential]", "");
                assert!(kept.len() <= 12, "prefix {prefix:?}: kept {kept}");
            }
        }
    }

    #[test]
    fn percent_encoded_token_is_replaced() {
        let needles = Needles::new("tok/with+reserved=chars&more");
        let (out, hit) = needles.scrub(Bytes::from_static(
            b"?t=tok%2Fwith%2Breserved%3Dchars%26more",
        ));
        assert!(hit);
        assert_eq!(&out[..], b"?t=[redacted:credential]");
    }

    #[test]
    fn unrelated_bytes_pass_through_untouched() {
        let input = Bytes::from_static(b"{\"zen\":\"Design for failure.\"}");
        let (out, hit) = Needles::new(TOKEN).scrub(input.clone());
        assert!(!hit);
        assert_eq!(out, input);
    }

    #[test]
    fn an_empty_token_matches_nothing() {
        let (out, hit) = Needles::new("").scrub(Bytes::from_static(b"anything"));
        assert!(!hit);
        assert_eq!(&out[..], b"anything");
    }

    #[test]
    fn header_values_are_scrubbed_as_text() {
        let (out, hit) = Needles::new(TOKEN).scrub_str(format!("req {TOKEN}"));
        assert!(hit);
        assert_eq!(out, "req [redacted:credential]");
    }
}
