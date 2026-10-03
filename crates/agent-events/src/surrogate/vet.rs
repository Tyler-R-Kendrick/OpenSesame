//! What may ride on a `surrogate.*` notice, decided before any of it is copied
//! into one.
//!
//! A refusal's free text is the one place an attacker's bytes reach the feed.
//! The host a misdirected surrogate was sent to is the host the attacker
//! chose, and the site a misplaced one turned up at is wherever the request's
//! author put it. So nothing is carried because it looked harmless: it is
//! carried because it passed a fence shaped like what it claims to be, and
//! anything that fails is withheld whole rather than trimmed into something
//! that merely looks clean.
//!
//! The fences are deliberately narrower than "does not contain the surrogate".
//! A surrogate that has been uppercased, or had its marker percent-encoded, or
//! lost its marker altogether, redeems nothing (ADR 0150 §7) — but it is still
//! the text that was issued, and a pager, a SIEM and a webhook receiver are
//! three more places it would then be sitting.

/// The marker every surrogate begins with (ADR 0150 §1). Compared without
/// regard to case: an uppercased surrogate is inert, not harmless to print.
const SURROGATE_MARKER: &str = "osr_";

/// Hex digits in a surrogate's body. A run this long is withheld from a detail
/// even without the marker, because the 128-bit body is the part that
/// identifies it; the marker only says what it is.
const SURROGATE_BODY_HEX: usize = 32;

/// Longest detail a surrogate notice carries — the feed's own cap, so the line
/// a person reads is the line every sink shows. A detail is a host or a site
/// name; one longer than this is not either, and is withheld, not truncated.
pub const MAX_SURROGATE_DETAIL_CHARS: usize = opensesame_security_events::MAX_DETAIL_CHARS;

/// Longest identifier (organization, run, provider) a surrogate notice
/// carries. The feed's label cap, since a provider id is shown as the label.
pub const MAX_SURROGATE_ID_CHARS: usize = opensesame_security_events::MAX_LABEL_CHARS;

/// Whether `raw` carries a surrogate's text: its marker in any case, or a hex
/// run as long as its body.
#[must_use]
pub fn carries_surrogate(raw: &str) -> bool {
    has_marker(raw) || longest_hex_run(raw) >= SURROGATE_BODY_HEX
}

fn has_marker(raw: &str) -> bool {
    raw.to_ascii_lowercase().contains(SURROGATE_MARKER)
}

fn longest_hex_run(raw: &str) -> usize {
    raw.chars()
        .fold((0_usize, 0_usize), |(longest, current), ch| {
            let current = if ch.is_ascii_hexdigit() {
                current + 1
            } else {
                0
            };
            (longest.max(current), current)
        })
        .0
}

/// A character a host, a `host:port`, a bracketed IPv6 literal, a header name
/// or a site name (`body`, `query`, `path`) can contain — and nothing else.
///
/// No space, slash, percent, equals, quote or control character: those are
/// what a URL, a header value or a request body is made of, and a detail that
/// contains one is not the host or site it is supposed to name.
const fn is_site_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']')
}

/// The detail, if it is a site name or a host and carries no surrogate.
///
/// `None` means withheld. The caller records that it was withheld; it never
/// substitutes a trimmed or masked version, because a masked surrogate is
/// still most of a surrogate.
#[must_use]
pub fn vet_detail(raw: &str) -> Option<String> {
    let fits = !raw.is_empty() && raw.chars().count() <= MAX_SURROGATE_DETAIL_CHARS;
    (fits && raw.chars().all(is_site_char) && !carries_surrogate(raw)).then(|| raw.to_string())
}

/// An identifier (organization, run, provider), if it carries no surrogate
/// marker, no whitespace, control character or percent sign, and fits.
///
/// Wider than [`vet_detail`] on purpose. An identifier comes from the ledger's
/// own issue record, not from the refused request, and a run id may well be a
/// 32-digit simple UUID; refusing hex runs here would withhold every such run
/// and turn a precise notice into an unattributed one. The marker is still
/// refused, because a surrogate that reached an id field is a bug that must not
/// become a page — and so is `%`, which is how a marker hides as `osr%5F`.
#[must_use]
pub fn vet_identifier(raw: &str) -> Option<String> {
    let fits = !raw.is_empty() && raw.chars().count() <= MAX_SURROGATE_ID_CHARS;
    let printable = raw.chars().all(|ch| ch.is_ascii_graphic() && ch != '%');
    (fits && printable && !has_marker(raw)).then(|| raw.to_string())
}
