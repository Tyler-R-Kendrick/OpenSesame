//! The interaction request digest, recomputed here rather than trusted
//! (ADR 0086, ADR 0150).
//!
//! The Identity API computes an interaction's `requestDigest` over what is
//! being asked, and a person's approval is bound to that digest. The approver
//! used to take the server's word for what the digest covers: it compared the
//! digest a proof was bound to with the digest the server reported, so a
//! server (or a fault) that reported a digest over something else would have
//! been believed. This module is the independent recomputation — the same
//! bytes `packages/os-domain` `crypto/request-digest.ts` hashes — so the
//! approver checks that the digest it is about to rely on is the digest *of
//! the request it sent*.
//!
//! The encoding is written down once, as vectors, in
//! `spec/conformance/request-digest-vectors.json` (ADR 0139); the vectors are
//! generated from the TypeScript implementation and this one must reproduce
//! every one of them (`tests/interaction_digest.rs`).
//!
//! Canonical JSON is `JSON.stringify` over a key-sorted copy, and it is
//! exactly that — including the two places a JavaScript object is not a map:
//! keys that are canonical array indices are walked first in ascending
//! numeric order, and every number is read as a double and written by
//! ECMAScript `Number::toString`. Anything this reader cannot reproduce with
//! certainty (nesting past [`MAX_DEPTH`], a number that is not finite) is an
//! error, never a guess, and the caller treats an error as a mismatch.

use std::cmp::Ordering;
use std::fmt::Write as _;

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use super::wire::INTERACTION_KIND;

/// The purpose string framed first, so a digest of another kind never
/// compares equal to this one.
pub const PURPOSE: &str = "opensesame:interaction-request:v1";
/// Canonical JSON refuses nesting deeper than this. The details this approver
/// sends are two levels deep; a server echoing more is not echoing them.
pub const MAX_DEPTH: usize = 64;
/// The largest canonical-array-index key (`2^32 - 2`).
const MAX_ARRAY_INDEX: u64 = 4_294_967_294;

/// Why a digest could not be computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DigestError {
    /// The details nest deeper than [`MAX_DEPTH`].
    #[error("the details nest deeper than the canonical form allows")]
    TooDeep,
    /// A number is not finite, or not a number this reader can write.
    #[error("the details hold a number the canonical form cannot write")]
    Number,
}

/// Everything the digest covers. Closed on purpose: a field added here is a
/// field added to `crypto/request-digest.ts` and to the vectors.
#[derive(Debug, Clone, Copy)]
pub struct RequestFields<'a> {
    /// The interaction kind (`authorization_request`).
    pub kind: &'a str,
    /// The fronted ceremony as `kind:id`.
    pub subject: &'a str,
    /// The approver's inbox handle.
    pub approver_ref: &'a str,
    /// The requester's opaque handle.
    pub requester_ref: &'a str,
    /// The RFC 9396 details, in order.
    pub authorization_details: &'a [Value],
    /// The sentence both screens show.
    pub binding_message: &'a str,
    /// The target handle, when there is one.
    pub resource_ref: Option<&'a str>,
    /// The end of the approval's window, ISO-8601.
    pub expires_at: &'a str,
}

/// `sha256:<hex>` over `fields`, length-prefixed field by field.
///
/// # Errors
///
/// [`DigestError`] when the details cannot be written canonically.
pub fn request_digest(fields: &RequestFields<'_>) -> Result<String, DigestError> {
    let details = canonical_details(fields.authorization_details)?;
    let mut hash = Sha256::new();
    for field in [
        PURPOSE,
        fields.kind,
        fields.subject,
        fields.approver_ref,
        fields.requester_ref,
        &details,
        fields.binding_message,
        fields.resource_ref.unwrap_or(""),
        fields.expires_at,
    ] {
        hash.update(field.len().to_string().as_bytes());
        hash.update([0_u8]);
        hash.update(field.as_bytes());
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

/// The canonical JSON of the details array.
///
/// # Errors
///
/// [`DigestError`] when the details nest too deep or hold a number that is
/// not finite.
pub fn canonical_details(details: &[Value]) -> Result<String, DigestError> {
    let mut out = String::new();
    write_array(details, &mut out, 1)?;
    Ok(out)
}

fn write_value(value: &Value, out: &mut String, depth: usize) -> Result<(), DigestError> {
    if depth > MAX_DEPTH {
        return Err(DigestError::TooDeep);
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(number, out)?,
        Value::String(text) => write_string(text, out),
        Value::Array(items) => write_array(items, out, depth)?,
        Value::Object(map) => write_object(map, out, depth)?,
    }
    Ok(())
}

fn write_array(items: &[Value], out: &mut String, depth: usize) -> Result<(), DigestError> {
    out.push('[');
    for (position, item) in items.iter().enumerate() {
        if position > 0 {
            out.push(',');
        }
        write_value(item, out, depth + 1)?;
    }
    out.push(']');
    Ok(())
}

/// The value of a key that is a canonical array index, else `None`: decimal
/// digits only, no leading zero, at most `2^32 - 2`.
fn array_index(key: &str) -> Option<u64> {
    let digits = !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit());
    let canonical = key == "0" || !key.starts_with('0');
    let index = key.parse::<u64>().ok()?;
    (digits && canonical && index <= MAX_ARRAY_INDEX).then_some(index)
}

/// The order `JSON.stringify` walks an object built by inserting the keys in
/// UTF-16 order: array indices first, ascending; everything else after, in
/// UTF-16 code-unit order.
fn key_order(a: &str, b: &str) -> Ordering {
    match (array_index(a), array_index(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
    }
}

fn write_object(
    map: &Map<String, Value>,
    out: &mut String,
    depth: usize,
) -> Result<(), DigestError> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_by(|a, b| key_order(a, b));
    out.push('{');
    for (position, key) in keys.into_iter().enumerate() {
        if position > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        if let Some(value) = map.get(key) {
            write_value(value, out, depth + 1)?;
        }
    }
    out.push('}');
    Ok(())
}

/// A string as `JSON.stringify` writes it: the two-character escapes, `\u00xx`
/// for the other control characters, nothing else escaped (DEL, U+2028 and
/// non-ASCII text stand as themselves).
fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                // Writing to a `String` cannot fail.
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_number(number: &Number, out: &mut String) -> Result<(), DigestError> {
    let value = number
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or(DigestError::Number)?;
    out.push_str(&es_number_string(value));
    Ok(())
}

/// ECMAScript `Number::toString(10)` for a finite double: the shortest digits
/// that round-trip, positional between `1e-7` and `1e21`, exponent form
/// outside them, and `-0` written `0`.
#[must_use]
pub fn es_number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    // The value is 0.<digits> x 10^point, the spec's `n`.
    let point = exponent + 1;
    let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    format!("{sign}{}", positional_or_exponent(&digits, count, point))
}

fn positional_or_exponent(digits: &str, count: i32, point: i32) -> String {
    let split = |at: i32| usize::try_from(at).unwrap_or(0);
    if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat(split(point - count)))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..split(point)], &digits[split(point)..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat(split(-point)))
    } else {
        let exponent = point - 1;
        let sign = if exponent < 0 { '-' } else { '+' };
        if count == 1 {
            format!("{digits}e{sign}{}", exponent.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], exponent.abs())
        }
    }
}

/// What a consumed interaction is checked against.
#[derive(Debug, Clone, Copy)]
pub struct Basis<'a> {
    /// The inbox handle the approver asked (its own configuration).
    pub approver_ref: &'a str,
    /// The id of the authorization request the interaction fronts.
    pub subject_id: &'a str,
}

/// True only when the consumed `InteractionDetail` hashes — by this crate's
/// own reckoning, from the fields the server reports it stores — to exactly
/// `expected`, and the server reports that same digest as its own.
///
/// Fail-closed: a field that is missing or of the wrong type, details this
/// reader cannot write canonically, and a `resourceRef` this approver never
/// sent all make it false.
#[must_use]
pub fn consumed_hashes_to(body: &Value, basis: &Basis<'_>, expected: &str) -> bool {
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    let (Some(requester_ref), Some(binding_message), Some(expires_at), Some(reported)) = (
        text("requesterRef"),
        text("bindingMessage"),
        text("expiresAt"),
        text("requestDigest"),
    ) else {
        return false;
    };
    let Some(details) = body.get("authorizationDetails").and_then(Value::as_array) else {
        return false;
    };
    // The approver names no target handle, so an interaction that reports one
    // is not the interaction it asked for.
    if body.get("resourceRef").is_some() {
        return false;
    }
    let subject = format!("{INTERACTION_KIND}:{}", basis.subject_id);
    let recomputed = request_digest(&RequestFields {
        kind: INTERACTION_KIND,
        subject: &subject,
        approver_ref: basis.approver_ref,
        requester_ref,
        authorization_details: details,
        binding_message,
        resource_ref: None,
        expires_at,
    });
    recomputed.is_ok_and(|digest| digest == expected && reported == expected)
}
