//! Breach-exposure detection against trusted public corpora.
//!
//! The platform already publishes what it knows about *time* — a certificate
//! that expires in a week, a credential due for rotation. This crate is the
//! same discipline applied to *exposure*: a stored secret that has turned up
//! in a public dump, or a provider that has announced a breach, is a fact the
//! platform detects once and publishes once, on the same feed, with the same
//! notification and alerting behind it.
//!
//! ```text
//! secret  →  PwnedDigest  →  prefix (5 hex chars leave the host)
//!                         →  range::occurrences (matched locally)
//!                         →  BreachEvent  →  SecurityNotice
//!
//! domain  →  catalogue::matches (fetched whole, matched locally)
//!                         →  BreachEvent  →  SecurityNotice
//! ```
//!
//! Two properties are the point of the design, and both are enforced by types
//! rather than by discipline:
//!
//! - **The source learns nothing about the tenant.** Password checks use the
//!   range API's k-anonymity: five hex characters of a SHA-1 go out, and the
//!   match happens here. Provider checks fetch the public catalogue whole and
//!   match locally. The breached-account API — which would require sending an
//!   address we hold on somebody else's behalf — is deliberately not used; see
//!   [`catalogue`].
//! - **A subscriber learns nothing about the value.** [`BreachSubject`] has no
//!   field able to carry one, and [`BreachEvent::payload`] builds its JSON key
//!   by key rather than serializing whatever a caller passed in.
//!
//! Nothing here does I/O. The gateway fetches; this crate decides.

pub mod catalogue;
mod digest;
mod event;
mod range;
mod source;
mod subject;

pub use catalogue::{domain_matches, matches, parse_catalogue, Breach, CATALOGUE_URL};
pub use digest::{PwnedDigest, DIGEST_CHARS, PREFIX_CHARS, SUFFIX_CHARS};
pub use event::{
    is_breach_event_type, BreachEvent, BREACH_EVENT_TYPES, EVENT_FINDING_CLEARED,
    EVENT_PASSWORD_COMPROMISED, EVENT_PROVIDER_DISCLOSED, EVENT_SCAN_FAILED, EVENT_WILDCARD,
    MAX_DETAIL_CHARS, MAX_LABEL_CHARS,
};
pub use range::{
    occurrences, occurrences_for_suffix, range_url, PADDING_HEADER, PADDING_VALUE, RANGE_URL_BASE,
};
pub use source::BreachSource;
pub use subject::{BreachSubject, BreachSubjectKind};
