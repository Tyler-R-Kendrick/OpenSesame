//! Frozen `surrogate.*` event names, and the conversion that puts a refused
//! surrogate on ADR 0080's one security feed (ADR 0150 §5).
//!
//! A surrogate (`osr_…`) stands in for a credential in a client we did not
//! write, and the broker admits it only at its one declared site, on its
//! provider's host, from the caller it was issued to, inside its scope. Every
//! other appearance is refused, and every refusal is a tripwire: the only way a
//! surrogate leaves its site is that something copied it. This module is how
//! that tripwire is heard.
//!
//! It is the fourth family on the feed, beside `lifecycle.*`, `breach.*` and
//! `agent.*`, and it gets there the same way: a conversion into
//! [`SecurityNotice`] and nothing else. It lives in this crate because a
//! surrogate is issued to an agent run and reports under that run, and it takes
//! plain strings rather than invoke-through's `Refusal` so that the feed's
//! vocabulary does not depend on the broker: the adapter hands over
//! `RefusalCode::as_str()` and the refusal's optional fields, and this module
//! decides what of them may be published.
//!
//! Three properties are structural:
//!
//! - **An unknown code is refused, not passed through.** A code this module
//!   does not know would publish under a name no subscription can have been
//!   registered for, and would read as a family nobody owns. The error does
//!   not repeat the code either, since a code field is exactly where a
//!   confused caller would put the surrogate.
//! - **Nothing an attacker wrote rides on the notice unless it is shaped like
//!   what it claims to be.** A detail is a host or a site name, or it is
//!   withheld whole; see `vet`. A withheld field is named in the payload, so
//!   an operator knows something was there.
//! - **A bad detail never suppresses the tripwire.** Withholding a field is
//!   the answer to a detail that fails its fence; refusing the notice would
//!   let an attacker silence the alarm by choosing an ugly host name.

use std::fmt;

use chrono::{DateTime, Utc};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;

mod vet;
pub use vet::{carries_surrogate, MAX_SURROGATE_DETAIL_CHARS, MAX_SURROGATE_ID_CHARS};
use vet::{vet_detail, vet_identifier};

/// More than one distinct surrogate in one request.
pub const EVENT_SURROGATE_AMBIGUOUS: &str = "surrogate.ambiguous";
/// Surrogate-shaped, but not one this broker issued.
pub const EVENT_SURROGATE_UNKNOWN: &str = "surrogate.unknown";
/// A surrogate presented after it was revoked, usually after its run ended.
pub const EVENT_SURROGATE_REVOKED: &str = "surrogate.revoked";
/// A surrogate presented after its expiry.
pub const EVENT_SURROGATE_EXPIRED: &str = "surrogate.expired";
/// A surrogate presented by a caller it was not issued to.
pub const EVENT_SURROGATE_FOREIGN_CALLER: &str = "surrogate.foreign_caller";
/// A surrogate sent to a host its provider's egress rule does not name.
pub const EVENT_SURROGATE_MISDIRECTED: &str = "surrogate.misdirected";
/// A surrogate sent to the right host over plain http.
pub const EVENT_SURROGATE_CLEARTEXT: &str = "surrogate.cleartext";
/// A surrogate somewhere other than exactly its declared site, once.
pub const EVENT_SURROGATE_MISPLACED: &str = "surrogate.misplaced";
/// A surrogate used with a method or path it was not scoped to.
pub const EVENT_SURROGATE_OUT_OF_SCOPE: &str = "surrogate.out_of_scope";

/// Every event type a hook may subscribe to in this family. Exactly the names
/// invoke-through's `RefusalCode::as_str` returns, which
/// `tests/surrogate_vocabulary_drift.rs` checks against the broker's source.
pub const SURROGATE_EVENT_TYPES: &[&str] = &[
    EVENT_SURROGATE_AMBIGUOUS,
    EVENT_SURROGATE_UNKNOWN,
    EVENT_SURROGATE_REVOKED,
    EVENT_SURROGATE_EXPIRED,
    EVENT_SURROGATE_FOREIGN_CALLER,
    EVENT_SURROGATE_MISDIRECTED,
    EVENT_SURROGATE_CLEARTEXT,
    EVENT_SURROGATE_MISPLACED,
    EVENT_SURROGATE_OUT_OF_SCOPE,
];

/// Subscription wildcard: every surrogate tripwire. Matched by the feed's
/// shared filter, as `agent.*` is.
pub const SURROGATE_EVENT_WILDCARD: &str = "surrogate.*";

/// Subject kind when the surrogate was one the ledger issued, so the run it
/// belonged to is known. The subject id is the run id: every tripwire one run
/// trips is one incident.
pub const SURROGATE_RUN_SUBJECT_KIND: &str = "agent_run";
/// Subject kind when no run is known — a forgery, a stale surrogate from
/// before a restart, two surrogates at once. The broker itself is the subject.
pub const SURROGATE_PROXY_SUBJECT_KIND: &str = "surrogate_proxy";
/// Every subject kind this family reports under.
pub const SURROGATE_SUBJECT_KINDS: &[&str] =
    &[SURROGATE_RUN_SUBJECT_KIND, SURROGATE_PROXY_SUBJECT_KIND];
/// Subject id under [`SURROGATE_PROXY_SUBJECT_KIND`]. One per organization, so
/// a burst of guesses collapses into one incident instead of one per guess.
pub const UNATTRIBUTED_SUBJECT: &str = "unattributed";

/// The organization a notice reports under when the caller has none. The
/// local daemon serves one person and holds no organization; a caller that
/// does have one must pass it, or its subscriptions never see the notice.
pub const LOCAL_ORGANIZATION: &str = "local";

/// The fence a refused surrogate hit, as the feed names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurrogateFence {
    Ambiguous,
    Unknown,
    Revoked,
    Expired,
    ForeignCaller,
    Misdirected,
    Cleartext,
    Misplaced,
    OutOfScope,
}

impl SurrogateFence {
    pub const ALL: [Self; 9] = [
        Self::Ambiguous,
        Self::Unknown,
        Self::Revoked,
        Self::Expired,
        Self::ForeignCaller,
        Self::Misdirected,
        Self::Cleartext,
        Self::Misplaced,
        Self::OutOfScope,
    ];

    /// The frozen event name this fence publishes under.
    #[must_use]
    pub const fn event_type(self) -> &'static str {
        match self {
            Self::Ambiguous => EVENT_SURROGATE_AMBIGUOUS,
            Self::Unknown => EVENT_SURROGATE_UNKNOWN,
            Self::Revoked => EVENT_SURROGATE_REVOKED,
            Self::Expired => EVENT_SURROGATE_EXPIRED,
            Self::ForeignCaller => EVENT_SURROGATE_FOREIGN_CALLER,
            Self::Misdirected => EVENT_SURROGATE_MISDIRECTED,
            Self::Cleartext => EVENT_SURROGATE_CLEARTEXT,
            Self::Misplaced => EVENT_SURROGATE_MISPLACED,
            Self::OutOfScope => EVENT_SURROGATE_OUT_OF_SCOPE,
        }
    }

    /// The fence named by a refusal code, exactly as invoke-through spells it.
    ///
    /// # Errors
    ///
    /// [`SurrogateNoticeError::UnknownCode`] for anything else — including the
    /// same name in another case, or with whitespace around it. A near miss is
    /// a caller bug, and guessing which fence it meant would publish a notice
    /// under a severity nobody chose.
    pub fn parse(code: &str) -> Result<Self, SurrogateNoticeError> {
        Self::ALL
            .into_iter()
            .find(|fence| fence.event_type() == code)
            .ok_or(SurrogateNoticeError::UnknownCode)
    }

    /// The fence's short name, the part after `surrogate.`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        let name = self.event_type();
        name.strip_prefix("surrogate.").unwrap_or(name)
    }

    /// How loud this tripwire is.
    ///
    /// Nothing here is `Critical`, deliberately: that rung means a credential
    /// is exposed, and a refused surrogate is the case where it is not — the
    /// fence held, and what was copied is worthless. The rungs below it are
    /// set by how strongly the refusal implies that a copy is loose:
    ///
    /// - `Error` — **misdirected**, **foreign caller**, **revoked**. Each is
    ///   the signature of exfiltration: a surrogate sent to a host that is not
    ///   its provider's, presented by a process it was never handed to, or used
    ///   after its run ended. None of these happens by accident in a client
    ///   that was merely configured wrong, and a watched run that trips one
    ///   should be parked (ADR 0150 §6.2), so a human has to look now.
    /// - `Warning` — **misplaced**, **out of scope**, **ambiguous**,
    ///   **cleartext**. The surrogate is with its own caller and pointed at its
    ///   own provider, but somewhere it should not be: in a body, beside a
    ///   second surrogate, outside its path, over http. That is how a
    ///   prompt-injected agent probes for a reflection oracle, and also how a
    ///   misconfigured SDK looks, so it deserves attention, not a page.
    /// - `Info` — **unknown**, **expired**. A restart revokes every surrogate
    ///   by forgetting it (ADR 0150 §1), so every long-lived client presents an
    ///   unknown one right after; a slow client outlives its expiry. Both are
    ///   ordinary. Guessing also lands here, and a guess redeems nothing.
    #[must_use]
    pub const fn severity(self) -> Severity {
        match self {
            Self::Misdirected | Self::ForeignCaller | Self::Revoked => Severity::Error,
            Self::Misplaced | Self::OutOfScope | Self::Ambiguous | Self::Cleartext => {
                Severity::Warning
            }
            Self::Unknown | Self::Expired => Severity::Info,
        }
    }

    /// One line a human reads first, naming the provider when it is known.
    fn headline(self, provider: Option<&str>) -> String {
        let of = provider.map_or_else(String::new, |provider| format!(" for {provider}"));
        match self {
            Self::Ambiguous => "a request carried more than one surrogate".to_string(),
            Self::Unknown => "a request carried a surrogate this broker never issued".to_string(),
            Self::Revoked => format!("a revoked surrogate{of} was presented"),
            Self::Expired => format!("an expired surrogate{of} was presented"),
            Self::ForeignCaller => {
                format!("a surrogate{of} was presented by a process it was not issued to")
            }
            Self::Misdirected => {
                format!("a surrogate{of} was sent to a host its provider does not use")
            }
            Self::Cleartext => format!("a surrogate{of} was sent over plain http"),
            Self::Misplaced => format!("a surrogate{of} appeared outside its declared site"),
            Self::OutOfScope => {
                format!("a surrogate{of} was used outside its method and path scope")
            }
        }
    }
}

#[must_use]
pub fn is_surrogate_event_type(event_type: &str) -> bool {
    SURROGATE_EVENT_TYPES.contains(&event_type)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SurrogateNoticeError {
    /// The code is not one of [`SURROGATE_EVENT_TYPES`]. The code itself is
    /// not repeated: it is caller text, and may be the surrogate.
    #[error("not a surrogate refusal code")]
    UnknownCode,
    /// The organization is not an identifier a notice may carry. It is the
    /// caller's own configuration, not the refused request's, so it is refused
    /// rather than withheld: a notice under a guessed organization reaches
    /// somebody else's subscriptions or nobody's.
    #[error("the organization is not an identifier a notice can carry")]
    InvalidOrganization,
}

/// What the broker knows about one refused request, as plain strings.
///
/// Mirrors invoke-through's `Refusal`: `code` is `RefusalCode::as_str()`, the
/// three options are its fields. Nothing in it has been vetted, so its `Debug`
/// prints the code and which fields are present, never their text.
#[derive(Clone, Copy)]
pub struct SurrogateRefusalReport<'a> {
    pub code: &'a str,
    pub run_id: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    /// For a misplaced surrogate, the site it was found at; for a misdirected
    /// one, the host it was sent to. Attacker-chosen in both cases.
    pub detail: Option<&'a str>,
    /// `None` reports under [`LOCAL_ORGANIZATION`].
    pub organization_id: Option<&'a str>,
    /// When the broker refused the request. Supplied rather than read from a
    /// clock so the conversion stays pure.
    pub occurred_at: DateTime<Utc>,
}

impl fmt::Debug for SurrogateRefusalReport<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let known = |field: Option<&str>| field.map(|_| "<unvetted>");
        f.debug_struct("SurrogateRefusalReport")
            .field("code", &SurrogateFence::parse(self.code).ok())
            .field("run_id", &known(self.run_id))
            .field("provider_id", &known(self.provider_id))
            .field("detail", &known(self.detail))
            .field("organization_id", &known(self.organization_id))
            .field("occurred_at", &self.occurred_at)
            .finish()
    }
}

mod event;
pub use event::SurrogateEvent;

/// A refused surrogate, as a notice on the security feed.
///
/// # Errors
///
/// See [`SurrogateEvent::from_report`].
pub fn surrogate_refusal_notice(
    report: &SurrogateRefusalReport<'_>,
) -> Result<SecurityNotice, SurrogateNoticeError> {
    SurrogateEvent::from_report(report).map(|event| event.notice())
}

/// A payload built key by key from vetted fields only.
fn payload(event: &SurrogateEvent, subject_kind: &str, subject_id: &str) -> Value {
    let mut body = Map::new();
    body.insert("event_type".into(), json!(event.fence.event_type()));
    body.insert("fence".into(), json!(event.fence.as_str()));
    body.insert("organization_id".into(), json!(event.organization_id));
    body.insert("subject_kind".into(), json!(subject_kind));
    body.insert("subject_id".into(), json!(subject_id));
    if let Some(run_id) = &event.run_id {
        body.insert("run_id".into(), json!(run_id));
    }
    if let Some(provider_id) = &event.provider_id {
        body.insert("provider_id".into(), json!(provider_id));
    }
    if let Some(detail) = &event.detail {
        body.insert("detail".into(), json!(detail));
    }
    body.insert("withheld".into(), json!(event.withheld));
    body.insert("occurred_at".into(), json!(event.occurred_at.to_rfc3339()));
    // Explicit non-disclosure, spelled so the audit redactor's unanchored deny
    // pattern (`value|token|secret|…`) cannot drop it: the claim a subscriber
    // needs is that the surrogate itself is never on this feed.
    body.insert("surrogate_included".into(), json!(false));
    Value::Object(body)
}

fn notice_of(event: &SurrogateEvent) -> SecurityNotice {
    let (subject_kind, subject_id) = event.subject();
    let headline = event.fence.headline(event.provider_id.as_deref());
    let summary = match &event.detail {
        Some(detail) => format!("{headline}: {detail}"),
        None => headline,
    };
    SecurityNotice {
        event_type: event.fence.event_type().to_string(),
        severity: event.fence.severity(),
        // A tripwire never resolves itself. A copy that got loose does not
        // stop being loose, and closing the page is a person's call.
        state: NoticeState::Firing,
        organization_id: event.organization_id.clone(),
        subject_kind: subject_kind.to_string(),
        payload: payload(event, subject_kind, &subject_id),
        subject_id,
        label: event.provider_id.clone(),
        occurred_at: event.occurred_at,
        summary,
        detail: event.detail.clone(),
    }
}

#[cfg(test)]
mod tests;
