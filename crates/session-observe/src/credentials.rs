//! The run lease owns the run's credentials (ADR 0150 §6.2).
//!
//! A sandboxed run may hold surrogates (`osr_…`) that the surrogate proxy
//! redeems on its behalf. Their lifetime is the run's autonomy, not a clock:
//! when the agent stops driving — the run is parked for a person, suspended,
//! or ends — whatever it was issued is revoked, so a copy left in a
//! transcript, a model provider's retention or a stray process is dead from
//! that moment.
//!
//! Two pieces, both pure:
//!
//! - [`RunCredentials`] — what revocation the embedder wires in. The default
//!   revokes nothing, so a run with no surrogates carries no ceremony.
//! - [`tripwire_verdict`] — the rule that a `surrogate.misdirected` notice for
//!   a *watched* run parks it. A surrogate sent to a host that is not its
//!   provider's has one explanation, a copy is loose, and a person who is
//!   watching should get the page back rather than read about it later. An
//!   unwatched run's notice still reaches the feed; there is nobody to hand
//!   the page to, so the verdict leaves the run to its owner's policy.

use crate::lease::{ControlError, ControlLease, ControlState, Quiescence};

/// The notice that parks a watched run. `crates/agent-events` freezes it; a
/// dev-only drift test pins the two together.
pub const MISDIRECTED_EVENT: &str = "surrogate.misdirected";

/// Revocation of what a run was issued. Called with the run's id when the
/// lease parks, suspends or ends.
pub trait RunCredentials {
    /// Revoke every credential issued to `run_id`; returns how many were live.
    /// The default revokes nothing.
    fn revoke(&self, run_id: &str) -> usize {
        let _ = run_id;
        0
    }
}

/// A run that was issued nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NoRunCredentials;

impl RunCredentials for NoRunCredentials {}

/// Park the run for a person and revoke its credentials.
///
/// Revocation follows only a successful park: a refused park (inside the
/// critical section, or a run already parked) leaves the lease where it was,
/// and a lease that did not move has not stopped the agent.
///
/// # Errors
///
/// Whatever [`ControlLease::park`] refuses.
pub fn park_and_revoke(
    lease: &mut ControlLease,
    run_id: &str,
    credentials: &dyn RunCredentials,
) -> Result<usize, ControlError> {
    lease.park()?;
    Ok(credentials.revoke(run_id))
}

/// Suspend the run and revoke its credentials. Permitted inside the critical
/// section, as [`ControlLease::suspend`] is.
///
/// # Errors
///
/// Whatever [`ControlLease::suspend`] refuses.
pub fn suspend_and_revoke(
    lease: &mut ControlLease,
    run_id: &str,
    credentials: &dyn RunCredentials,
) -> Result<usize, ControlError> {
    lease.suspend()?;
    Ok(credentials.revoke(run_id))
}

/// The run is over, however it ended: revoke unconditionally.
pub fn end_and_revoke(run_id: &str, credentials: &dyn RunCredentials) -> usize {
    credentials.revoke(run_id)
}

/// One notice as the rule reads it: its event name and the run it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunNotice<'a> {
    pub event_type: &'a str,
    pub run_id: Option<&'a str>,
}

/// What a watched run's notices ask of its lease.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TripwireVerdict {
    /// Nothing that parks this run.
    Continue,
    /// Park it for the person watching.
    Park,
    /// Park is refused inside `assert -> submit`; suspend instead, which
    /// ADR 0076 constraint 5 treats as an indeterminate outcome to reconcile.
    Suspend,
}

/// Whether `notices` park `run_id`, given whether anyone is watching and
/// where its lease is.
///
/// Only a `surrogate.misdirected` naming this run counts; another run's
/// tripwire, or another fence's, is that run's or the feed's business. A run
/// the agent no longer drives has nothing to stop.
#[must_use]
pub fn tripwire_verdict(
    notices: &[RunNotice<'_>],
    run_id: &str,
    watched: bool,
    lease: ControlLease,
) -> TripwireVerdict {
    let tripped = notices
        .iter()
        .any(|notice| notice.event_type == MISDIRECTED_EVENT && notice.run_id == Some(run_id));
    let driving = matches!(
        lease.state(),
        ControlState::AgentDriving | ControlState::HandoffRequested
    );
    if !(watched && tripped && driving) {
        return TripwireVerdict::Continue;
    }
    match lease.quiescence() {
        Quiescence::Quiescent => TripwireVerdict::Park,
        Quiescence::Critical => TripwireVerdict::Suspend,
    }
}

/// Carry out a verdict: park or suspend, and revoke. `Ok(None)` when the
/// verdict was to continue.
///
/// # Errors
///
/// Whatever the lease refuses.
pub fn apply_tripwire(
    verdict: TripwireVerdict,
    lease: &mut ControlLease,
    run_id: &str,
    credentials: &dyn RunCredentials,
) -> Result<Option<usize>, ControlError> {
    match verdict {
        TripwireVerdict::Continue => Ok(None),
        TripwireVerdict::Park => park_and_revoke(lease, run_id, credentials).map(Some),
        TripwireVerdict::Suspend => suspend_and_revoke(lease, run_id, credentials).map(Some),
    }
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
