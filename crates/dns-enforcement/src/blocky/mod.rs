//! Blocky's HTTP API at a pinned version, as pure request specs and parsers.
//!
//! Everything here is a value: an [`Operation`] becomes a [`RequestSpec`], and a
//! response body becomes a parsed outcome. No I/O, so the part of the protocol
//! that matters for safety is testable without a server, and
//! [`crate::transport`] is left with nothing to decide.
//!
//! - [`request`] — what this crate asks for, and the request it cannot build.
//! - [`response`] — what comes back, and the three ways a query can end.
//!
//! # The request this module cannot build
//!
//! `GET /api/blocking/disable` takes an optional `groups` parameter. Blocky's
//! own documentation puts it plainly — *"If empty, disable all groups"* — and
//! the measurement was worse than that reads: against [`PINNED_VERSION`], a bare
//! disable returned
//! `{"disabledGroups":["default","unit-alpha","unit-beta"],"enabled":false}`
//! with **no `autoEnableInSec`**. Every group, indefinitely, until something
//! called `enable`.
//!
//! That is one omitted query parameter between "permit this one domain for ten
//! minutes" and "switch the filter off for everybody until further notice". So
//! [`DisableGroups`] cannot be constructed empty, and there is deliberately no
//! function anywhere in this crate that turns an allowance into a disable. An
//! allowance is a list entry plus [`Operation::RefreshLists`]; that is the only
//! road, and it leaves `blocking/status` reading `enabled: true` throughout —
//! also measured.

pub mod request;
pub mod response;

pub use request::{DisableGroups, DisableWindow, Method, Operation, RequestSpec};
pub use response::{
    admitted_but_unresolved, allowlist_document, parse_query, parse_status, BlockingStatus,
    QueryOutcome, Resolution,
};

/// The Blocky release every claim in this crate was measured against.
pub const PINNED_VERSION: &str = "v0.35.0";

/// The prefix Blocky mounts its API under.
pub const API_PREFIX: &str = "/api";

/// The response type Blocky reports for a name its denylists refused.
pub const RESPONSE_TYPE_BLOCKED: &str = "BLOCKED";

/// Why a protocol value could not be built or read.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// A disable was attempted with no groups, which would disable all of them.
    #[error("a disable with no groups disables every group; name the groups explicitly")]
    DisableWithoutGroups,
    /// A group name was empty or held a separator that would split it in the
    /// comma-joined query parameter.
    #[error("`{group}` is not a usable group name")]
    BadGroupName {
        /// The offending name.
        group: String,
    },
    /// A disable window was zero or negative.
    #[error("a disable window must be positive, got {seconds}s")]
    BadWindow {
        /// The window that was offered.
        seconds: i64,
    },
    /// The response body was not the JSON this version returns.
    #[error("unreadable response body: {detail}")]
    Unreadable {
        /// What went wrong, for an operator log.
        detail: String,
    },
}

#[cfg(test)]
mod tests {
    use super::PINNED_VERSION;

    #[test]
    fn the_pinned_version_is_recorded_next_to_the_claims_it_backs() {
        assert_eq!(PINNED_VERSION, "v0.35.0");
    }
}
