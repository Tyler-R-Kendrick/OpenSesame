//! Refusals: which fence a request hit, for the owner's notice, and the one
//! message the client gets whatever the fence.

use super::{SurrogateSpec, SURROGATE_HEX_LEN, SURROGATE_MARKER};

/// Longest detail worth reporting: a DNS name's limit.
const MAX_DETAIL: usize = 253;

/// The fence a refused request hit. Stable strings: they become the
/// `surrogate.*` notice names on ADR 0080's feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalCode {
    /// More than one distinct surrogate in one request.
    Ambiguous,
    /// Surrogate-shaped, but not one this ledger issued.
    Unknown,
    Revoked,
    Expired,
    /// Issued to another caller.
    ForeignCaller,
    /// Sent to a host its provider's rule does not name.
    Misdirected,
    /// Sent to the right host over plain http.
    Cleartext,
    /// Present somewhere other than exactly its declared site, once.
    Misplaced,
    /// Right host, right site, but a method or path the surrogate was not
    /// scoped to — or a path with dot segments an upstream might resolve out
    /// of its prefix.
    OutOfScope,
}

impl RefusalCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ambiguous => "surrogate.ambiguous",
            Self::Unknown => "surrogate.unknown",
            Self::Revoked => "surrogate.revoked",
            Self::Expired => "surrogate.expired",
            Self::ForeignCaller => "surrogate.foreign_caller",
            Self::Misdirected => "surrogate.misdirected",
            Self::Cleartext => "surrogate.cleartext",
            Self::Misplaced => "surrogate.misplaced",
            Self::OutOfScope => "surrogate.out_of_scope",
        }
    }
}

/// A refused request. Carries what the owner's notice needs and never the
/// surrogate itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: RefusalCode,
    /// Known only when the surrogate was one this ledger issued.
    pub run_id: Option<String>,
    pub provider_id: Option<String>,
    /// For `Misplaced`: the site it was found at (`path`, `body`, a header
    /// name). For `Misdirected`: the host it was sent to. For `OutOfScope`:
    /// the method, or `path`. The request is the caller's, so a detail that
    /// is not a plain name or holds anything shaped like a surrogate is
    /// [`Refusal::WITHHELD`] instead.
    pub detail: Option<String>,
}

impl Refusal {
    /// The one thing a refused client is told, whatever the code.
    pub const CLIENT_MESSAGE: &'static str = "request refused by the credential broker";

    /// What [`Refusal::detail`] says in place of a detail it will not repeat.
    pub const WITHHELD: &'static str = "[withheld]";

    pub(super) fn bare(code: RefusalCode) -> Self {
        Self {
            code,
            run_id: None,
            provider_id: None,
            detail: None,
        }
    }

    pub(super) fn issued(code: RefusalCode, spec: &SurrogateSpec, detail: Option<String>) -> Self {
        Self {
            code,
            run_id: Some(spec.run_id.clone()),
            provider_id: Some(spec.provider_id.clone()),
            detail: detail.map(vetted),
        }
    }
}

/// `detail` when it is a plain host, header name, site or method with nothing
/// shaped like a surrogate in it; [`Refusal::WITHHELD`] otherwise.
fn vetted(detail: String) -> String {
    let plain = !detail.is_empty()
        && detail.len() <= MAX_DETAIL
        && detail
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
        && !detail.to_ascii_lowercase().contains(SURROGATE_MARKER)
        && !has_hex_run(&detail, SURROGATE_HEX_LEN);
    if plain {
        detail
    } else {
        Refusal::WITHHELD.to_owned()
    }
}

/// Whether `text` holds `len` hex digits in a row: a surrogate's body, with
/// or without its marker.
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
