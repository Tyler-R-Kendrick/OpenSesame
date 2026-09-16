//! Enforcement guarantees, described honestly enough to refuse a grant.
//!
//! A deployment issues authority whose terms somebody will later try to hold:
//! a deadline, a revocation, a boundary the subject is not supposed to cross.
//! Whether those terms can be kept is a property of the *platform the subject
//! runs on*, and it is not one number. The scalar this crate replaces — a
//! `hard` that outranked a `best_effort` — was being used to mean any of four
//! unrelated things, so a caller who needed "the subject cannot defeat it" was
//! answered by an adapter that meant "it usually happens within a minute".
//!
//! What is here instead:
//!
//! - [`Dimension`] — three axes, no ordering between them. Expiry,
//!   termination, isolation. A platform that lapses a credential but cannot
//!   stop a run in flight is not *weaker* than one that does the reverse, and
//!   nothing in this crate will rank them.
//! - [`Guarantee`] — one axis's answer as five independent facts (who
//!   enforces, what bypass takes, how fast, what it outlives, how we would
//!   know) plus the [`Mechanism`] that produces them. There is no method that
//!   returns a score.
//! - [`EnforcementDescriptor`] — a platform and surface, answering every
//!   dimension with either a guarantee or a named [`Unsupported`]. It cannot
//!   be built without answering all of them, and building it runs
//!   [`conformance::audit`].
//! - [`Requirements`] — what a grant needs, field by field, so the refusal can
//!   be read back as the question that failed. [`grant::requirements_for`]
//!   derives them from a grant's own constraints.
//! - [`preflight`] — the refusal. Every unmet demand, with the platform's own
//!   [`UnsupportedResponse`] where the answer was that nothing enforces it.
//! - [`Effect`] and [`EffectLedger`] — [`Desired`] and [`Observed`] as two
//!   separate states. Authority asking is not the platform doing, nothing
//!   copies one into the other, and a dimension nothing can observe
//!   [`Diverges`](Divergence::Unverifiable) rather than quietly converging.
//!
//! ## Ownership is the load-bearing distinction
//!
//! Not "strong" versus "weak" but *independent* versus *self-administered*.
//! [`EnforcementPoint::independent_of_subject`] is consulted by the audit (a
//! library inside the subject may not claim to be hard to bypass, may not
//! claim to act before the subject's next use, and may not report on itself),
//! by preflight (a requirement can demand independence), and by the effect
//! ledger (a report from the subject is refused, not recorded). And
//! [`SubjectSurface`] decides which points are even in the path: once a
//! credential is minted into the subject's hands, a descriptor claiming the
//! Host broker enforces anything is describing a call path that does not
//! exist.
//!
//! ## No adapter is a value, not a gap
//!
//! There is no iOS adapter and no Android adapter in this repository, so
//! [`platform::catalog`] carries both as
//! [`AdapterStatus::Absent`] with every dimension answered
//! [`UnsupportedReason::NoAdapter`], and the audit refuses any descriptor that
//! declares an absent adapter while claiming enforcement. A preflight against
//! them fails with machine-readable reasons and remedies rather than admitting
//! a grant nothing will keep. Writing plausible-looking mobile guarantees
//! would be the single most damaging change anyone could make to this crate.
//!
//! Nothing here does I/O, holds a credential value, or reads a clock: clock
//! readings arrive as seconds from the caller, and every string in a
//! descriptor is a checked-in `&'static str`.

#![forbid(unsafe_code)]

pub mod conformance;
pub mod descriptor;
pub mod dimension;
pub mod effect;
pub mod grant;
pub mod guarantee;
pub mod ledger;
pub mod ownership;
pub mod platform;
pub mod preflight;
pub mod requirement;
pub mod unsupported;

pub use conformance::{audit, ConformanceViolation};
pub use descriptor::{
    AdapterStatus, Coverage, DescriptorBuilder, DimensionCoverage, EnforcementDescriptor,
};
pub use dimension::Dimension;
pub use effect::{
    Desired, Divergence, Effect, FailureCode, Observed, Reconciliation, Report, ReportRefused,
};
pub use grant::{preflight_grant, requirements_for, GrantTerms, OfflineUse};
pub use guarantee::{Bypass, Guarantee, Latency, Mechanism, Observability, Survival};
pub use ledger::{DimensionNotTracked, EffectLedger, LedgerReportRefused};
pub use ownership::{EnforcementPoint, SubjectSurface};
pub use platform::{catalog, Catalog, CatalogError};
pub use preflight::{preflight, Admitted, Refusal, Shortfall, Unmet};
pub use requirement::{Requirement, Requirements};
pub use unsupported::{Remedy, Unsupported, UnsupportedReason, UnsupportedResponse};
