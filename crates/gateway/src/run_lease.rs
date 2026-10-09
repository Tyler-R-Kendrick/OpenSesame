//! The run lease owns the run's credentials, on the Host (ADR 0150 §6.2).
//!
//! A sandboxed run may hold surrogates (`osr_…`), and their lifetime is the
//! run's autonomy: when the agent stops driving, whatever it was issued is
//! revoked. `crates/session-observe` owns the rule ([`RunCredentials`],
//! [`tripwire_verdict`]); this is where the Host applies it, in the two
//! places it owns a run's lifecycle:
//!
//! - **The feed.** Every `agent.*` fact and every `surrogate.*` tripwire
//!   passes [`crate::security::dispatch::publish`], and [`settle`] reads each
//!   one against the run it names. An `agent.*` phase in which the agent no
//!   longer drives (blocked, awaiting a person, control granted, completed,
//!   failed) ends the run's credentials. A `surrogate.misdirected` for a run
//!   the Host holds an observation row for parks it, or suspends it inside
//!   the critical section, and revokes; a run someone is watching gets the
//!   page back instead of a line in a log. A run the Host has no row for has
//!   no lease to move, and its notice reaches the subscribers as before.
//! - **Taking the page.** A person taking control of a run ends the agent's
//!   autonomy ([`end_run`]).
//!
//! An observation run exists to be watched, so every row is a watched run.
//! Nothing here carries a surrogate: a notice names a run and a fence only.

use chrono::Utc;
use opensesame_agent_events::surrogate::{EVENT_SURROGATE_MISDIRECTED, SURROGATE_RUN_SUBJECT_KIND};
use opensesame_agent_events::{is_agent_event_type, AgentEvent, AgentPhase};
use opensesame_security_events::SecurityNotice;
use opensesame_session_observe::{
    apply_tripwire, end_and_revoke, tripwire_verdict, ControlLease, ControlState, Quiescence,
    RunCredentials, RunNotice,
};
use opensesame_storage::{ObservationControlUpdate, StoredObservationRun};

use crate::app_state::AppState;

/// How many times a park re-reads a run that moved under it before giving up.
const PARK_ATTEMPTS: usize = 3;

/// The value-blind reason a tripwire parks a run under.
const PARKED_FOR: &str = "surrogate.misdirected";

/// Rebuild the lease machine from the persisted run.
///
/// The database holds a projection; `ControlLease` holds the rules. Reading the
/// projection back into the machine before every transition is what stops the
/// two from drifting — a state the machine forbids cannot be reached by writing
/// a column, because the write only happens if the machine allowed it first.
pub(crate) fn lease_from(run: &StoredObservationRun) -> Option<ControlLease> {
    let state = match run.control_state.as_str() {
        "agent_driving" => ControlState::AgentDriving,
        "handoff_requested" => ControlState::HandoffRequested,
        "awaiting_human" => ControlState::AwaitingHuman,
        "human_driving" => ControlState::HumanDriving,
        "resume_requested" => ControlState::ResumeRequested,
        "suspended" => ControlState::Suspended,
        _ => return None,
    };
    let quiescence = match run.quiescence.as_str() {
        "quiescent" => Quiescence::Quiescent,
        "critical" => Quiescence::Critical,
        _ => return None,
    };
    ControlLease::restore(state, quiescence, run.handoff_queued)
}

pub(crate) const fn state_name(state: ControlState) -> &'static str {
    match state {
        ControlState::AgentDriving => "agent_driving",
        ControlState::HandoffRequested => "handoff_requested",
        ControlState::AwaitingHuman => "awaiting_human",
        ControlState::HumanDriving => "human_driving",
        ControlState::ResumeRequested => "resume_requested",
        ControlState::Suspended => "suspended",
    }
}

pub(crate) const fn quiescence_name(quiescence: Quiescence) -> &'static str {
    match quiescence {
        Quiescence::Quiescent => "quiescent",
        Quiescence::Critical => "critical",
    }
}

/// A person took the page from `run_id`: the agent no longer drives, so what
/// it was issued is revoked. Returns how many credentials were live.
pub(crate) fn end_run(state: &AppState, run_id: &str) -> usize {
    end_and_revoke(run_id, &*state.run_credentials)
}

/// Read one notice on the feed against the run it names.
pub(crate) async fn settle(state: &AppState, notice: &SecurityNotice) {
    if let Some(run_id) = stopped_run(notice) {
        end_run(state, &run_id);
    } else if notice.event_type == EVENT_SURROGATE_MISDIRECTED
        && notice.subject_kind == SURROGATE_RUN_SUBJECT_KIND
    {
        park_watched(state, notice).await;
    }
}

/// The run an `agent.*` notice reports as no longer driven by the agent.
fn stopped_run(notice: &SecurityNotice) -> Option<String> {
    if !is_agent_event_type(&notice.event_type) {
        return None;
    }
    let event = AgentEvent::from_payload(&notice.payload)?;
    matches!(
        event.phase,
        AgentPhase::Blocked
            | AgentPhase::AwaitingHuman
            | AgentPhase::ControlGranted
            | AgentPhase::Completed
            | AgentPhase::Failed
    )
    .then_some(event.run.run_id)
}

/// Park (or suspend) the run a misdirected surrogate names, and revoke.
async fn park_watched(state: &AppState, notice: &SecurityNotice) {
    let run_id = notice.subject_id.as_str();
    for _ in 0..PARK_ATTEMPTS {
        let Some(run) = open_run(state, &notice.organization_id, run_id).await else {
            return;
        };
        if let Settled::Done = park_once(state, notice, &run).await {
            return;
        }
    }
}

/// The run, if the Host holds one under `run_id` that has not been closed.
async fn open_run(
    state: &AppState,
    organization_id: &str,
    run_id: &str,
) -> Option<StoredObservationRun> {
    match state.db.get_observation_run(organization_id, run_id).await {
        Ok(found) => found.filter(|run| run.closed_at.is_none()),
        Err(error) => {
            tracing::error!(%error, run_id, "tripwire could not read the run");
            None
        }
    }
}

/// Whether a park attempt is finished or the run moved under it.
enum Settled {
    Done,
    Stale,
}

/// One attempt: decide from the run as read, move the lease, revoke, and
/// write the new state under the version it was decided on.
async fn park_once(
    state: &AppState,
    notice: &SecurityNotice,
    run: &StoredObservationRun,
) -> Settled {
    let run_id = run.id.as_str();
    let Some(mut lease) = lease_from(run) else {
        return Settled::Done;
    };
    let notices = [RunNotice {
        event_type: &notice.event_type,
        run_id: Some(run_id),
    }];
    let verdict = tripwire_verdict(&notices, run_id, true, lease);
    let credentials: &dyn RunCredentials = &*state.run_credentials;
    if !matches!(
        apply_tripwire(verdict, &mut lease, run_id, credentials),
        Ok(Some(_))
    ) {
        return Settled::Done;
    }
    let update = ObservationControlUpdate {
        run_id: run.id.clone(),
        organization_id: run.organization_id.clone(),
        expected_version: run.version,
        control_state: state_name(lease.state()).into(),
        quiescence: quiescence_name(lease.quiescence()).into(),
        handoff_queued: lease.handoff_queued(),
        lease_holder: None,
        lease_expires_at: None,
        blocked_reason: Some(PARKED_FOR.into()),
    };
    match state
        .db
        .update_observation_control(&update, &Utc::now().to_rfc3339())
        .await
    {
        Ok(None) => Settled::Stale,
        Ok(Some(_)) => Settled::Done,
        Err(error) => {
            tracing::error!(%error, run_id, "tripwire park could not be written");
            Settled::Done
        }
    }
}

#[cfg(test)]
#[path = "run_lease_tests.rs"]
mod tests;
