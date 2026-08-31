//! The security-event feed's common vocabulary.
//!
//! `OpenSesame` detects several kinds of security fact — a certificate about to
//! expire, a stored password found in a public breach corpus, a provider that
//! announced an incident — and every one of them needs the same three things
//! to happen: publish it on a feed anyone can subscribe to, notify a human,
//! and, if it is loud enough, raise an alert an on-call rotation will see.
//!
//! Doing that three separate times is how the third detector ends up with no
//! alerting. So it is done once, here:
//!
//! ```text
//! detector  →  SecurityNotice  →  hook feed        (subscribers)
//!                              →  built-in notify  (always)
//!                              →  built-in alert   (at or above a floor)
//!                                   ├─ Alertmanager v2
//!                                   ├─ `PagerDuty` Events API v2
//!                                   └─ RFC 5424 syslog, locally
//! ```
//!
//! A new detector implements a conversion into [`SecurityNotice`] and inherits
//! all of it. It does not get to invent its own notification path, which is
//! the point — a private path is a path that rots unwatched.
//!
//! Nothing in this crate does I/O, and nothing in it can carry a credential:
//! [`SecurityNotice`] has no field able to hold a value, and
//! [`SecurityNotice::safe_payload`] strips secret-shaped keys from the source
//! payload as a second fence behind each detector's own structural tests.

mod delivery;
pub mod filter;
mod notice;
pub mod render;
mod severity;

pub use delivery::Delivery;
pub use notice::{
    NoticeState, SecurityNotice, MAX_DETAIL_CHARS, MAX_LABEL_CHARS, MAX_SUMMARY_CHARS,
};
pub use severity::Severity;
