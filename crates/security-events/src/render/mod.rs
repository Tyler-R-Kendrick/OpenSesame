//! Renderings of a [`crate::SecurityNotice`] in the formats operators already
//! run.
//!
//! Every module here is pure: a notice in, a body or a line out, no I/O and no
//! configuration beyond what is passed. That is what makes them testable
//! against the published wire contracts, and what keeps the decision of
//! *whether* to alert separate from the mechanics of *how*.

pub mod alertmanager;
pub mod pagerduty;
pub mod syslog;
