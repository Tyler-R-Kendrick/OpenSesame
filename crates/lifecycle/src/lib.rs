//! Expiry lifecycle for the Host authority plane.
//!
//! When a certificate, a brokered credential, a signing key, or a sealed-store
//! entry approaches its deadline, that is a *fact* the platform detects and
//! publishes — not a private detail of whichever subsystem happens to own the
//! thing. This crate is the vocabulary for that fact:
//!
//! - [`ExpirySubject`] — what is expiring, as metadata only.
//! - [`ExpiryStage`] — the ladder of rungs a deadline crosses, ordered by time
//!   remaining so a per-subject renewal lead time slots in wherever it belongs.
//! - [`LifecycleEvent`] — the frozen, value-blind payload a hook subscriber
//!   receives.
//! - [`evaluate`] — the pure decision: given a subject, its watermarks, and a
//!   clock reading, the events it owes.
//!
//! Nothing here does I/O. The gateway supplies subjects and persistence, and
//! **`OpenSesame`'s own rotation and certificate responders subscribe to the same
//! events an external tool does** — the platform has no private trigger path
//! that would let the public one rot (ADR 0073).
//!
//! The crate structurally cannot leak credential material: [`ExpirySubject`]
//! has no field able to carry a value, and [`LifecycleEvent::payload`] builds
//! its JSON key by key rather than by serializing whatever a caller passed in.

mod evaluate;
mod event;
mod stage;
mod subject;

pub use evaluate::{evaluate, should_respond, Watermark, Watermarks};
pub use event::{
    event_type_for_stage, filter_is_valid, filter_matches, is_lifecycle_event_type, LifecycleEvent,
    EVENT_EXPIRY_EXPIRED, EVENT_EXPIRY_NOTICE, EVENT_EXPIRY_URGENT, EVENT_EXPIRY_WARNING,
    EVENT_RENEWAL_DUE, EVENT_RENEWAL_FAILED, EVENT_RENEWAL_SUCCEEDED, EVENT_WILDCARD,
    LIFECYCLE_EVENT_TYPES, MAX_DETAIL_CHARS, MAX_LABEL_CHARS,
};
pub use stage::{
    ladder, newly_crossed, ExpiryStage, Track, DEFAULT_RENEW_BEFORE_SECONDS, NOTICE_SECONDS,
    URGENT_SECONDS, WARNING_SECONDS, WATERMARK_UNFIRED,
};
pub use subject::{ExpirySubject, SubjectKind};
