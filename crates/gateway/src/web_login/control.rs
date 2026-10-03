//! The persisted control state, consulted before every step (ADR 0081 §6-§7).
//!
//! The executor keeps a [`ControlLease`] of its own, and it can only know what
//! its own code did. A person who asks for the page does it through the
//! control routes, which write the run's row — so before this, a handoff
//! requested mid-run was invisible to the run, and the executor kept driving a
//! page a person believed they were about to hold.
//!
//! [`ControlGate`] closes that. It is the executor's lease *projected onto the
//! row the routes write*, and the step channel calls it around every dispatch:
//!
//! - **Before a step**, it reads the row. `agent_driving` proceeds. An
//!   accepted `handoff_requested` **parks the run** here — a safe point,
//!   between steps — by writing `awaiting_human`, and no step is enqueued.
//!   Any state that is a person's (or nobody's) refuses the step: while a
//!   person holds the page nothing is queued for the browser, and autonomy is
//!   never resumed by the run itself (the machine has no such edge).
//! - **Around the critical section** it mirrors what the executor does. The
//!   executor opens the span at `assert_present` and closes it when `submit`
//!   returns. The gate persists `quiescence = critical` when it lets an
//!   assertion through, so a handoff requested inside the span is *queued* by
//!   the routes rather than accepted — exactly what the lease machine says —
//!   and it never parks, or refuses on a queued handoff, between the assertion
//!   and the submit: that is the span nothing may interrupt (ADR 0076
//!   constraint 3). When the span closes, a queued handoff is released into
//!   `handoff_requested`, and the very next step parks.
//!
//! Every write is guarded by the row's version, like the routes', so "exactly
//! one driver" holds across processes.

use std::sync::Mutex;

use opensesame_rotation_web::{Presence, StepError, StepOutcome};
use opensesame_session_observe::{ControlLease, ControlState, Quiescence};
use opensesame_storage::{Db, ObservationControlUpdate, StoredObservationRun};
use serde_json::Value;

/// The step that opens the critical section: the fail-closed presence
/// assertion. Pinned to `StepRequest`'s wire name by a test.
pub(crate) const ASSERT_STEP: &str = "assert_present";
/// The step that ends it.
pub(crate) const SUBMIT_STEP: &str = "submit";

/// The hint a run parked at a handoff carries.
pub(crate) const HANDOFF_PARKED: &str = "parked at a safe point for a person";

/// How often a write is retried when another writer moved the row first.
const ATTEMPTS: usize = 5;

/// Why the run stopped issuing steps for a reason that is not its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    /// A person asked for the page and the run parked for them.
    HandedOff,
    /// The page is a person's (or nobody's) already; the run sent nothing.
    PersonHasIt,
    /// The run's row is gone, closed or unreadable.
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Ordinary,
    Assert,
    Submit,
}

fn kind_of(request: &Value) -> Kind {
    match request.get("step").and_then(Value::as_str) {
        Some(ASSERT_STEP) => Kind::Assert,
        Some(SUBMIT_STEP) => Kind::Submit,
        _ => Kind::Ordinary,
    }
}

enum Decision {
    Proceed,
    Park,
    Refuse(Stop),
}

/// One run's control state, as the step channel consults it.
pub(crate) struct ControlGate {
    db: Db,
    organization_id: String,
    run_id: String,
    stop: Mutex<Option<Stop>>,
}

/// The lease machine, rebuilt from the row. The wire names are the enums' own
/// serde names, so the two cannot drift apart.
pub(super) fn lease_of(run: &StoredObservationRun) -> Option<ControlLease> {
    let state: ControlState =
        serde_json::from_value(Value::String(run.control_state.clone())).ok()?;
    let quiescence: Quiescence =
        serde_json::from_value(Value::String(run.quiescence.clone())).ok()?;
    ControlLease::restore(state, quiescence, run.handoff_queued)
}

pub(super) fn wire<T: serde::Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// What the lease must become for `kind` to go ahead, and whether it may.
fn advance(kind: Kind, lease: &mut ControlLease) -> Decision {
    if lease.state() == ControlState::AgentDriving && lease.quiescence() == Quiescence::Critical {
        if kind == Kind::Submit || kind == Kind::Assert {
            // Inside the span (a submit), or a repeated assertion: nothing here
            // may park, and nothing here may move the lease.
            return Decision::Proceed;
        }
        // An ordinary step means the span is over — the assertion failed and
        // the executor suspended its own lease. Close it here too, and let a
        // handoff that was queued inside it take effect.
        let _ = lease.leave_critical();
    }
    match (kind, lease.state(), lease.quiescence()) {
        (Kind::Submit, state, _) => Decision::Refuse(if state == ControlState::AgentDriving {
            // The span was never opened on the row: nothing vouches that the
            // assertion still holds, so the submit is not sent.
            Stop::Gone
        } else {
            Stop::PersonHasIt
        }),
        (_, ControlState::HandoffRequested, _) => {
            if lease.park().is_ok() {
                Decision::Park
            } else {
                Decision::Refuse(Stop::Gone)
            }
        }
        (Kind::Assert, ControlState::AgentDriving, _) => {
            if lease.enter_critical().is_ok() {
                Decision::Proceed
            } else {
                Decision::Refuse(Stop::Gone)
            }
        }
        (Kind::Ordinary, ControlState::AgentDriving, _) => Decision::Proceed,
        _ => Decision::Refuse(Stop::PersonHasIt),
    }
}

impl ControlGate {
    pub(crate) fn new(db: Db, organization_id: String, run_id: String) -> Self {
        Self {
            db,
            organization_id,
            run_id,
            stop: Mutex::new(None),
        }
    }

    /// Why the run stopped, if the gate is what stopped it.
    pub(crate) fn stopped(&self) -> Option<Stop> {
        *self
            .stop
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn stop(&self, why: Stop) -> StepError {
        let mut stop = self
            .stop
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        stop.get_or_insert(why);
        StepError::Transport
    }

    /// The open run's row, or why there is none.
    async fn read(&self) -> Result<StoredObservationRun, Stop> {
        match self
            .db
            .get_observation_run(&self.organization_id, &self.run_id)
            .await
        {
            Ok(Some(run)) if run.closed_at.is_none() => Ok(run),
            Ok(_) => Err(Stop::Gone),
            Err(error) => {
                tracing::warn!(%error, run_id = %self.run_id, "control state could not be read");
                Err(Stop::Gone)
            }
        }
    }

    /// Write `lease` over `run`. `Ok(false)` when another writer moved the row.
    async fn commit(
        &self,
        run: &StoredObservationRun,
        lease: ControlLease,
        blocked_reason: Option<&str>,
    ) -> Result<bool, StepError> {
        let update = ObservationControlUpdate {
            run_id: run.id.clone(),
            organization_id: run.organization_id.clone(),
            expected_version: run.version,
            control_state: wire(lease.state()),
            quiescence: wire(lease.quiescence()),
            handoff_queued: lease.handoff_queued(),
            lease_holder: None,
            lease_expires_at: None,
            blocked_reason: blocked_reason
                .map(str::to_owned)
                .or_else(|| run.blocked_reason.clone()),
        };
        match self
            .db
            .update_observation_control(&update, &chrono::Utc::now().to_rfc3339())
            .await
        {
            Ok(moved) => Ok(moved.is_some()),
            Err(error) => {
                tracing::warn!(%error, run_id = %self.run_id, "control state could not be written");
                Err(StepError::Transport)
            }
        }
    }

    /// Decide whether `request` may be handed to the driver.
    ///
    /// # Errors
    ///
    /// [`StepError::Transport`] when it may not: the run parked at a handoff,
    /// a person holds the page, or the row cannot be read or written. The
    /// step is then never enqueued.
    pub(crate) async fn before(&self, request: &Value) -> Result<(), StepError> {
        let kind = kind_of(request);
        for _ in 0..ATTEMPTS {
            let run = self.read().await.map_err(|why| self.stop(why))?;
            let Some(mut lease) = lease_of(&run) else {
                return Err(self.stop(Stop::Gone));
            };
            let before = lease;
            let decision = advance(kind, &mut lease);
            let reason = matches!(decision, Decision::Park).then_some(HANDOFF_PARKED);
            match decision {
                Decision::Refuse(why) => return Err(self.stop(why)),
                _ if lease == before => return Ok(()),
                _ => {}
            }
            if self.commit(&run, lease, reason).await? {
                return match reason {
                    Some(_) => Err(self.stop(Stop::HandedOff)),
                    None => Ok(()),
                };
            }
        }
        // Another writer kept moving the row; sending a step on a state that
        // will not hold still is not safe.
        Err(self.stop(Stop::Gone))
    }

    /// Record what the step did to the critical section.
    ///
    /// A submit always ends it, and so does an assertion that did not come
    /// back `Present` — the executor suspends its own lease there and sends
    /// nothing more. Whatever handoff was queued inside is released now.
    pub(crate) async fn after(&self, request: &Value, outcome: &Result<Value, StepError>) {
        let leaves = match kind_of(request) {
            Kind::Submit => true,
            Kind::Assert => !asserted_present(outcome),
            Kind::Ordinary => false,
        };
        if !leaves {
            return;
        }
        for _ in 0..ATTEMPTS {
            let Ok(run) = self.read().await else { return };
            let Some(mut lease) = lease_of(&run) else {
                return;
            };
            if lease.quiescence() != Quiescence::Critical || lease.leave_critical().is_err() {
                return;
            }
            match self.commit(&run, lease, None).await {
                Ok(true) | Err(_) => return,
                Ok(false) => {}
            }
        }
        tracing::warn!(run_id = %self.run_id, "the critical section could not be closed on the row");
    }
}

fn asserted_present(outcome: &Result<Value, StepError>) -> bool {
    matches!(
        outcome
            .as_ref()
            .ok()
            .and_then(|value| serde_json::from_value::<StepOutcome>(value.clone()).ok()),
        Some(StepOutcome::Presence {
            presence: Presence::Present
        })
    )
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
