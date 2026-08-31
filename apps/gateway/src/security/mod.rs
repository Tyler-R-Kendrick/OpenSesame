//! The security-event feed (ADR 0080).
//!
//! One feed for every security fact the platform detects, with one
//! subscription model, one delivery ledger, and one pair of subscribers that
//! are always listening:
//!
//! ```text
//! detector  →  SecurityNotice  →  security::dispatch::publish
//!                                   ├─ TaskBus
//!                                   ├─ delivery ledger → sinks::deliver
//!                                   │    ├─ Standard Webhooks
//!                                   │    ├─ Alertmanager v2
//!                                   │    └─ PagerDuty Events API v2
//!                                   ├─ notify  (always, RFC 5424 locally)
//!                                   └─ alert   (warning and above)
//! ```
//!
//! Expiry ([`crate::lifecycle`]) and breach exposure ([`crate::breach`]) both
//! publish here, and neither knows the other exists. The rule this enforces is
//! the one ADR 0074 established for rotation and ADR 0080 generalizes: a
//! detector does not get a private notification path, because a private path is
//! one nobody is watching when it breaks.

pub mod alert;
pub mod delivery;
pub mod dispatch;
pub mod hooks;
pub mod notify;
pub mod sinks;
