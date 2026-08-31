//! Breach-exposure detection (ADR 0080).
//!
//! ```text
//! subjects::watched_domains  →  sources::catalogue  →  breach_intel::matches
//!                                                   →  breach_findings ledger
//!                                                   →  security::dispatch
//! ```
//!
//! The second detector on the security-event feed, and the reason the feed was
//! generalized: it publishes through exactly the path expiry does, so the
//! alerting an operator configured for certificates covers compromised
//! credentials on the day it is deployed, with nothing to wire up.
//!
//! What leaves the host is confined to [`sources`], and neither request in it
//! carries anything about a tenant. See [`opensesame_breach_intel`] for why —
//! including why the breached-account API is deliberately unused.

pub mod scanner;
pub mod sources;
pub mod subjects;
