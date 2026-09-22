//! Optional independent-authority duress hold / quarantine / recovery on Host.
//!
//! Browser-local Pages scenarios never require this module (ADR 0130). Host
//! participates only when an enrolled profile names an
//! `independent_authority` hold or peer quarantine that this Host accepted.
//! Timer expiry never auto-unlocks; recovery resolution is explicit and
//! epoch-bound.

mod epochs;
mod hold;
mod ops;
mod ops_core;
mod quarantine;
mod store;

#[cfg(test)]
mod ops_tests;

pub use epochs::{ceiling_for_hold, DurableEpochs};
pub use hold::{admits_recovery_attempt, HoldDuration, HoldPhase, IndependentHold};
pub use ops_core::{
    accept_independent_hold, active_ceiling, gate_boundary, quarantine_peer, request_recovery,
    resolve_recovery, supersede_incident, DuressOpError, DuressPurpose, IncidentState,
    QuarantineRecord,
};
pub use quarantine::{mark_quarantine_active, mark_quarantine_inactive};
pub use store::DuressAuthorityStore;

#[cfg(test)]
mod tests;
