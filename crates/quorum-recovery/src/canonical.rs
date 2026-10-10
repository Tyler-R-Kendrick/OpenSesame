//! Canonical JSON and the framed digest every quorum signature is bound to.
//!
//! This is `packages/app-core/src/lib/quorum/canonical.ts` rule for rule:
//!
//! - object keys are sorted by UTF-16 code unit, recursively; array order stays;
//! - only integers are numbers, and only safe ones (`|n| <= 2^53 - 1`);
//! - strings are written as `JSON.stringify` writes them;
//! - fields are framed as `<utf-8 byte length in decimal>\0<bytes>`, the
//!   purpose string first, so a digest made for one use cannot serve another.

use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A value the canonical form does not admit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CanonicalError {
    /// A float, or an integer beyond 2^53 - 1.
    #[error("canonical JSON allows safe integers only")]
    Number,
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                // Lower-case hex, four digits, as JSON.stringify writes it.
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_number(out: &mut String, number: &serde_json::Number) -> Result<(), CanonicalError> {
    if let Some(n) = number.as_u64() {
        if n > MAX_SAFE_INTEGER {
            return Err(CanonicalError::Number);
        }
        let _ = write!(out, "{n}");
    } else if let Some(n) = number.as_i64() {
        if n.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(CanonicalError::Number);
        }
        let _ = write!(out, "{n}");
    } else {
        // JavaScript parses `1.0` and `1e2` to the integers 1 and 100, so a
        // float that is a whole safe number is that integer here too.
        let f = number.as_f64().ok_or(CanonicalError::Number)?;
        if f.fract() != 0.0 || f.abs() > 9_007_199_254_740_991.0 {
            return Err(CanonicalError::Number);
        }
        // `-0` prints as `0`; the cast is exact because `f` is a whole safe number.
        #[allow(clippy::cast_possible_truncation)]
        let whole = f as i64;
        let _ = write!(out, "{whole}");
    }
    Ok(())
}

fn write_value(out: &mut String, value: &Value) -> Result<(), CanonicalError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n)?,
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, (key, entry)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, entry)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// The canonical JSON text of `value`.
///
/// # Errors
/// [`CanonicalError::Number`] for a float or an unsafe integer.
pub fn canonicalize(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(&mut out, value)?;
    Ok(out)
}

/// Each field as its UTF-8 byte length in decimal, a NUL, then its bytes.
#[must_use]
pub fn frame(fields: &[&str]) -> Vec<u8> {
    // Sized exactly, so a growing buffer never leaves a stale copy behind: a
    // field can be a share (the commitment to it is framed).
    let capacity = fields
        .iter()
        .map(|f| f.len().to_string().len() + 1 + f.len())
        .sum();
    let mut out = Vec::with_capacity(capacity);
    for field in fields {
        out.extend_from_slice(field.len().to_string().as_bytes());
        out.push(0);
        out.extend_from_slice(field.as_bytes());
    }
    out
}

/// `sha256:<hex>` over the purpose and fields, framed.
#[must_use]
pub fn framed_digest(purpose: &str, fields: &[&str]) -> String {
    let mut all = Vec::with_capacity(fields.len() + 1);
    all.push(purpose);
    all.extend_from_slice(fields);
    let mut text = String::from("sha256:");
    for byte in Sha256::digest(Zeroizing::new(frame(&all))) {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{canonicalize, frame, framed_digest, CanonicalError};

    #[test]
    fn sorts_keys_recursively_and_keeps_array_order() {
        let value = json!({"b": [3, {"z": 1, "a": 2}], "a": null, "c": true});
        assert_eq!(
            canonicalize(&value).unwrap(),
            r#"{"a":null,"b":[3,{"a":2,"z":1}],"c":true}"#
        );
    }

    #[test]
    fn sorts_by_utf16_code_unit_not_by_utf8_byte() {
        // U+FF5E is one UTF-16 unit (0xFF5E); U+1F600 is the pair D83D DE00.
        // UTF-16 order puts the emoji first; UTF-8 byte order puts it last.
        let value = json!({"\u{ff5e}": 1, "\u{1f600}": 2});
        assert_eq!(
            canonicalize(&value).unwrap(),
            "{\"\u{1f600}\":2,\"\u{ff5e}\":1}"
        );
    }

    #[test]
    fn writes_strings_as_json_stringify_does() {
        let value = json!("a\"b\\c\n\u{1}\u{7f}\u{2028}é");
        assert_eq!(
            canonicalize(&value).unwrap(),
            "\"a\\\"b\\\\c\\n\\u0001\u{7f}\u{2028}é\""
        );
    }

    #[test]
    fn admits_only_safe_integers() {
        assert_eq!(canonicalize(&json!(-5)).unwrap(), "-5");
        assert_eq!(
            canonicalize(&json!(9_007_199_254_740_991_u64)).unwrap(),
            "9007199254740991"
        );
        assert_eq!(canonicalize(&json!(1.5)), Err(CanonicalError::Number));
        assert_eq!(
            canonicalize(&json!(9_007_199_254_740_992_u64)),
            Err(CanonicalError::Number)
        );
        let whole: serde_json::Value = serde_json::from_str("2.0").unwrap();
        assert_eq!(canonicalize(&whole).unwrap(), "2");
    }

    #[test]
    fn frames_are_length_prefixed_in_bytes() {
        assert_eq!(frame(&["ab", "é"]), b"2\0ab2\0\xc3\xa9");
        assert_ne!(frame(&["ab", "c"]), frame(&["a", "bc"]));
    }

    #[test]
    fn a_digest_is_bound_to_its_purpose() {
        let a = framed_digest("purpose-a", &["x"]);
        assert!(a.starts_with("sha256:") && a.len() == 71);
        assert_ne!(a, framed_digest("purpose-b", &["x"]));
    }
}
