//! A web-login run's outcome on the `agent.*` feed (ADR 0081, ADR 0159).
//!
//! A web login is observed, so its runs are announced there as well as on the
//! lifecycle feed: `lifecycle.*` reports that a deadline was acted on,
//! `agent.*` that a run needs a person — and it is the second that a phone
//! should ring for.
//!
//! An event names two ids and they are different things. `run_id` is the
//! **observation run** — what a person attaches to (`/runs/{run_id}`), and
//! what an A2H cancel reply closes. `job_id` is the rotation job the run
//! served. Naming the job as the run sent a person to a page that does not
//! exist and made a cancel reply match no run.

use chrono::Utc;
use opensesame_agent_events::{AgentEvent, AgentPhase, AgentRun};
use opensesame_lifecycle::LifecycleEvent;

use super::outcome::Outcome;
use crate::app_state::AppState;

/// How long a person has to pick up a blocked web-login run before it is only
/// a parked row.
///
/// It bounds the notification, not the database: acting inside the window
/// resumes *this* run, and acting after it starts a fresh one. An escalation
/// with no clock is one nobody can act on in time, so `crates/agent-events`
/// makes the deadline a construction requirement rather than a field somebody
/// remembers to fill in.
pub(crate) const WEB_LOGIN_RESPONSE_WINDOW_SECONDS: i64 = 3_600;

/// The `run_id` an event carries when no observation run was ever opened — a
/// job parked before a run could start. There is nothing to attach to.
pub(crate) const NO_RUN: &str = "unassigned";

/// The ids an announcement is about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RunRefs {
    /// The rotation job, when one was requested.
    pub job_id: Option<String>,
    /// The observation run, when one was opened.
    pub run_id: Option<String>,
}

/// Control states a stopped run may truthfully report: the ones where the
/// agent is no longer the one driving.
const PARKED_STATES: [&str; 4] = [
    "awaiting_human",
    "human_driving",
    "resume_requested",
    "suspended",
];

/// Announce a web-login run's outcome on the `agent.*` feed.
///
/// A failed web-login rotation is not merely a failure: ADR 0076's whole T5
/// design is that a run which cannot continue parks and asks a person to show
/// it the way through. So failure maps to `agent.run.blocked` — an escalation
/// with a deadline — rather than to a notice nobody is expected to answer.
pub(crate) async fn publish_agent_phase(
    state: &AppState,
    event: &LifecycleEvent,
    owner_subject: Option<String>,
    refs: &RunRefs,
    outcome: &Outcome,
) {
    // Without an owner there is nobody entitled to observe the run and nobody
    // to notify (ADR 0081 §8). `upsert_rotation_policy` refuses a web-login
    // policy with no owner, so reaching here means a policy predating that rule
    // or an operator-triggered run — either way, saying nothing to nobody beats
    // addressing a notification at the whole organization.
    let Some(owner_principal_id) = owner_subject else {
        tracing::warn!(
            subject_id = %event.subject.subject_id,
            "web-login run has no owner; no agent event published",
        );
        return;
    };
    let control_state =
        control_state_of(state, &event.subject.organization_id, refs, outcome).await;
    let run = AgentRun {
        run_id: refs.run_id.clone().unwrap_or_else(|| NO_RUN.into()),
        job_id: refs.job_id.clone().unwrap_or_default(),
        organization_id: event.subject.organization_id.clone(),
        owner_principal_id,
        origin: event.subject.subject_id.clone(),
        // Without a runner the ladder never reaches the agentic rung; a run
        // that did reach it is published by the runner itself.
        tier: "t3".into(),
        control_state,
    };
    announce(state, run, outcome).await;
}

/// Publish `outcome` for `run` on the shared feed.
pub(crate) async fn announce(state: &AppState, run: AgentRun, outcome: &Outcome) {
    let now = Utc::now();
    let built = if outcome.succeeded {
        AgentEvent::reporting(run, AgentPhase::Completed, now, Some(&outcome.detail))
    } else {
        AgentEvent::waiting(
            run,
            AgentPhase::Blocked,
            now,
            now + chrono::Duration::seconds(WEB_LOGIN_RESPONSE_WINDOW_SECONDS),
            Some(&outcome.detail),
        )
    };
    match built {
        // ADR 0080's one feed, entered the only way a family may enter it:
        // as a `SecurityNotice`. Everything a subscriber, the notifier, the
        // alerter and every sink do with this is already written.
        Ok(agent_event) => {
            crate::security::dispatch::publish(state, &agent_event.notice(), now).await;
        }
        Err(error) => tracing::warn!(%error, "agent event could not be built"),
    }
}

/// The control state to report: the run's own when a person has (or is owed)
/// the page, otherwise what the outcome implies.
async fn control_state_of(
    state: &AppState,
    organization_id: &str,
    refs: &RunRefs,
    outcome: &Outcome,
) -> String {
    if outcome.succeeded {
        return "agent_driving".into();
    }
    if let Some(run_id) = refs.run_id.as_deref() {
        if let Ok(Some(run)) = state.db.get_observation_run(organization_id, run_id).await {
            if PARKED_STATES.contains(&run.control_state.as_str()) {
                return run.control_state;
            }
        }
    }
    "suspended".into()
}
