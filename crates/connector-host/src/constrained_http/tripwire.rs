//! A refused placeholder is a tripwire (ADR 0150 §5): reported for the
//! owner with the fence, the run and the provider, never the placeholder,
//! and answered with the one message every refusal gets.
//!
//! The refusal's detail is the site, host or method the request used, and
//! the request is the caller's: a header named for the placeholder, a host
//! that spells it (`osr_….evil.example`) or a method that is it puts the
//! live placeholder into the detail. So the detail is reported only when it
//! is shaped like what it describes and holds nothing shaped like a
//! placeholder; otherwise it is withheld and the report still goes out.

use opensesame_invoke_through::surrogate::{SURROGATE_HEX_LEN, SURROGATE_MARKER};
use opensesame_invoke_through::Refusal;

use crate::HostError;

/// What the report says in place of a detail it will not repeat.
pub(super) const WITHHELD: &str = "[withheld]";

/// Longest detail worth reporting: a DNS name's limit.
const MAX_DETAIL: usize = 253;

pub(super) fn tripwire(refusal: &Refusal) -> HostError {
    tracing::warn!(
        target: "opensesame::surrogate",
        notice = refusal.code.as_str(),
        run_id = refusal.run_id.as_deref().unwrap_or("-"),
        provider_id = refusal.provider_id.as_deref().unwrap_or("-"),
        detail = reported_detail(refusal),
        "placeholder refused at admission"
    );
    HostError::SurrogateRefused(refusal.code)
}

/// The detail as the report carries it: `-` when there is none, the detail
/// itself when it is a plain host, header name, site or method, and
/// [`WITHHELD`] for anything else.
pub(super) fn reported_detail(refusal: &Refusal) -> &str {
    match refusal.detail.as_deref() {
        None => "-",
        Some(detail) if is_reportable(detail) => detail,
        Some(_) => WITHHELD,
    }
}

fn is_reportable(detail: &str) -> bool {
    !detail.is_empty()
        && detail.len() <= MAX_DETAIL
        && detail
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
        && !detail.to_ascii_lowercase().contains(SURROGATE_MARKER)
        && !has_hex_run(detail, SURROGATE_HEX_LEN)
}

/// Whether `text` holds `len` hex digits in a row: a placeholder's body,
/// with or without its marker.
fn has_hex_run(text: &str, len: usize) -> bool {
    let mut run = 0;
    for b in text.bytes() {
        run = if b.is_ascii_hexdigit() { run + 1 } else { 0 };
        if run >= len {
            return true;
        }
    }
    false
}

#[cfg(test)]
#[path = "tripwire_tests.rs"]
mod tests;
