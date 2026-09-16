//! DNS-layer enforcement, and an honest account of what that is worth.
//!
//! A recursive resolver that refuses to answer for a name is a real
//! enforcement point: it sits outside the subject, the subject does not hold
//! the decision, and defeating it takes more than editing the subject's own
//! configuration. It is also a *narrow* one, and most of this crate exists to
//! keep the second fact as visible as the first. See [`coverage`].
//!
//! The backend is [Blocky], pinned at [`blocky::PINNED_VERSION`]. Every claim
//! this crate makes about Blocky's behaviour was measured against that exact
//! build, not read off its documentation — where the two disagreed, the
//! measurement won, and the disagreements are recorded in
//! `docs/validation/dns-enforcement-coverage.md`.
//!
//! # The three findings that shape the API
//!
//! 1. **An allowance is a list entry, never a disable.** Blocky's
//!    `GET /api/blocking/disable` takes an optional `groups` parameter, and
//!    omitting it disables *every* group — measured: all three groups went
//!    down, with no `autoEnableInSec`, so the filter stayed off until something
//!    turned it back on. A caller asking to permit one domain must never be
//!    able to reach that. There is deliberately no function in this crate that
//!    maps an allowance onto a disable, and [`blocky::DisableGroups`] cannot be
//!    constructed empty. See [`blocky`].
//!
//! 2. **List groups are not an isolation boundary; client identities are.**
//!    With one client subscribed to two groups, an allowlist entry in the
//!    *second* group defeated a denylist entry in the first — Blocky reported
//!    `failed to resolve allowlisted domain` for a name the other group
//!    denied. With each client bound to exactly one group, the same allowance
//!    left the other client blocked. [`topology`] therefore refuses a
//!    configuration that binds one client to more than one enforcement unit,
//!    because that configuration silently shares allowances between units.
//!
//! 3. **Nothing in Blocky expires a list entry.** Its only autonomous timer is
//!    the whole-group disable this crate refuses to use. So an allowance's
//!    deadline is held by whoever reconciles the lists, and [`lifetime`] says
//!    so in the type system rather than implying the resolver is watching the
//!    clock. It runs no timer of its own: reconciliation is a pure function the
//!    caller drives, which is also what `INV-GA-05` requires.
//!
//! [Blocky]: https://github.com/0xERR0R/blocky
//!
//! # Layout
//!
//! - [`scope`] — which names an allowance may name, and how one narrows another.
//! - [`topology`] — enforcement units, their client bindings, and the isolation audit.
//! - [`lifetime`] — deadlines, and who actually holds them.
//! - [`coverage`] — what DNS enforcement covers, and the claims it refuses to make.
//! - [`blocky`] — the pinned protocol, as pure request specs and parsers.
//! - [`transport`] — the HTTP client, and the refusal when Blocky is not there.

pub mod blocky;
pub mod coverage;
pub mod lifetime;
pub mod refusal;
pub mod scope;
pub mod topology;
pub mod transport;

pub use blocky::{BlockingStatus, DisableGroups, QueryOutcome, Resolution, PINNED_VERSION};
pub use coverage::{Claim, Coverage, Uncovered};
pub use lifetime::{Allowance, ExpiryHolder, ReconciledLists};
pub use refusal::Refusal;
pub use scope::DomainRule;
pub use topology::{ClientId, Topology, UnitId};
