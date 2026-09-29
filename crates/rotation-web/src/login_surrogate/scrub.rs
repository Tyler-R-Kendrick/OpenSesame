//! The credential never rides back to the model (ADR 0150 §4, for a login).
//!
//! Once the runner has substituted a credential, a response body or a DOM
//! snapshot can carry it back: a login error page that echoes the submitted
//! form, a debug route, a `value` attribute a framework re-renders. Before any
//! of that reaches the model it goes through [`ResponseScrub`].
//!
//! **Related to invoke-through's scrub, not a copy of it.** The base64
//! alignment trick is invoke-through's `scrub::Needles`
//! (`crates/invoke-through/src/scrub.rs`), repeated here rather than depended
//! on: this crate is the runner's contract and does not take the broker's
//! HTTP stack as a dependency. A change to either's base64 needles is made to
//! both. The text encodings are matched differently, and more broadly: a login
//! round-trip echoes a form into HTML, JSON and redirect URLs through
//! whatever encoder the site uses, so each is matched as a dialect
//! (`dialect.rs`) that accepts any spelling of each character rather than a
//! fixed list of whole-credential forms.
//!
//! What is matched: the credential with any of its characters percent-encoded
//! in either hex case, and `+` for a space (RFC 3986, the form serializer,
//! `encodeURIComponent`); JSON-escaped in any mix of short escapes and
//! `\u` escapes in either case, astral characters as surrogate pairs (serde,
//! `JSON.stringify`, Python's ASCII-only default, Go's HTML-safe escaping);
//! HTML-escaped with any mix of named, decimal and hex references (Django,
//! Go's `html/template`, an entity per character); the raw credential, which
//! every dialect accepts; and its base64 body in both alphabets at all three
//! byte alignments. What is not matched: two layers of encoding at once, a
//! hash, an encryption or any other transform (ADR 0150 §8).

mod dialect;

use std::fmt;

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

use crate::tools::RedactedDom;

/// What replaces a reflected credential.
pub const REDACTED: &str = "[redacted:credential]";

/// Base64 needles shorter than this are not searched for: a short run of
/// base64 characters matches ordinary text by chance.
const MIN_ENCODED_NEEDLE: usize = 12;

/// One credential and its base64 forms, held zeroized: the forms are the
/// credential by another name.
pub struct ResponseScrub {
    credential: Zeroizing<String>,
    base64: Vec<Zeroizing<Vec<u8>>>,
}

/// Counts only: the fields are the credential.
impl fmt::Debug for ResponseScrub {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResponseScrub")
            .field("dialects", &dialect::ALL.len())
            .field("base64_forms", &self.base64.len())
            .finish_non_exhaustive()
    }
}

impl ResponseScrub {
    #[must_use]
    pub fn new(credential: &SecretString) -> Self {
        let token = credential.expose_secret();
        let mut base64: Vec<Zeroizing<Vec<u8>>> = Vec::new();
        let forms = (0..3).flat_map(|alignment| {
            [false, true]
                .into_iter()
                .filter_map(move |url_safe| aligned_base64(token.as_bytes(), alignment, url_safe))
        });
        for form in forms {
            if !base64.iter().any(|known| **known == *form) {
                base64.push(form);
            }
        }
        // Longest first, so a form that contains another is replaced whole.
        base64.sort_by_key(|form| std::cmp::Reverse(form.len()));
        Self {
            credential: Zeroizing::new(token.to_string()),
            base64,
        }
    }

    /// `bytes` with every form replaced, and whether any was found.
    #[must_use]
    pub fn scrub(&self, bytes: &[u8]) -> (Vec<u8>, bool) {
        let mut current: Option<Vec<u8>> = None;
        for form in &self.base64 {
            let haystack = current.as_deref().unwrap_or(bytes);
            if let Some(replaced) = replace_all(haystack, form) {
                current = Some(replaced);
            }
        }
        for dialect in dialect::ALL {
            let haystack = current.as_deref().unwrap_or(bytes);
            let marker = REDACTED.as_bytes();
            if let Some(replaced) = dialect::replace(dialect, haystack, &self.credential, marker) {
                current = Some(replaced);
            }
        }
        match current {
            Some(scrubbed) => (scrubbed, true),
            None => (bytes.to_vec(), false),
        }
    }

    /// Text with every form replaced, and whether any was found.
    #[must_use]
    pub fn scrub_text(&self, text: &str) -> (String, bool) {
        let (scrubbed, hit) = self.scrub(text.as_bytes());
        if !hit {
            return (text.to_string(), false);
        }
        // Every replaced run starts at a character boundary and ends after a
        // whole character or escape, and the marker is ASCII, so the result
        // stays UTF-8; fall back to the bare marker rather than trust that
        // silently.
        let text = String::from_utf8(scrubbed).unwrap_or_else(|_| REDACTED.to_string());
        (text, true)
    }

    /// A redacted DOM with the credential scrubbed from it too. Stripping
    /// removes field values; this removes the credential wherever else the
    /// page re-rendered it, such as an error message quoting the form.
    #[must_use]
    pub fn scrub_dom(&self, dom: RedactedDom) -> (RedactedDom, bool) {
        let (text, hit) = self.scrub_text(dom.text());
        if !hit {
            return (dom, false);
        }
        let epoch = RedactedDom::epoch(&dom);
        (RedactedDom::from_stripped(text, epoch), true)
    }
}

/// The base64 characters that depend on `token` alone when it sits
/// `alignment` bytes into a 3-byte group. See invoke-through's `scrub.rs`.
fn aligned_base64(token: &[u8], alignment: usize, url_safe: bool) -> Option<Zeroizing<Vec<u8>>> {
    if token.is_empty() {
        return None;
    }
    let mut padded = Zeroizing::new(vec![0u8; alignment]);
    padded.extend_from_slice(token);
    let encoded = Zeroizing::new(if url_safe {
        URL_SAFE_NO_PAD.encode(padded.as_slice())
    } else {
        STANDARD_NO_PAD.encode(padded.as_slice())
    });
    let skip = if alignment == 0 { 0 } else { 4 };
    let end = (padded.len() / 3) * 4;
    if end <= skip || end - skip < MIN_ENCODED_NEEDLE {
        return None;
    }
    Some(Zeroizing::new(encoded.as_bytes()[skip..end].to_vec()))
}

/// `haystack` with every non-overlapping `needle` replaced by [`REDACTED`],
/// or `None` when the needle does not occur.
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
            buf.extend_from_slice(REDACTED.as_bytes());
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
mod tests {
    use super::*;

    #[test]
    fn debug_prints_counts_and_never_the_credential() {
        let scrub = ResponseScrub::new(&SecretString::from("hunter2-correct-horse".to_string()));
        let shown = format!("{scrub:?}");
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(!shown.contains("aHVudGVy"), "{shown}");
    }
}
