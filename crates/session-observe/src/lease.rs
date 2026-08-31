use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Who is entitled to act on the sandbox page right now.
///
/// A live preview is only worth having if the person watching can step in, and
/// stepping in is only safe if exactly one actor is driving. Two actors in one
/// DOM race the fail-closed presence assertion that stands between a rotation
/// and a lockout (ADR 0076 constraint 3), and leave a receipt that cannot say
/// who did what.
///
/// The one-way property this machine exists to enforce: **autonomy is never
/// resumed by a timeout**. Every edge back to [`ControlState::AgentDriving`]
/// leaves from a state where either the agent never stopped
/// ([`ControlState::HandoffRequested`], withdrawn) or a human handed control
/// back and the run's preconditions were re-asserted
/// ([`ControlState::ResumeRequested`]). A lease that simply expires lands in
/// [`ControlState::Suspended`], because resuming a model into a page a human
/// left in an unknown state is the improvisation ADR 0076 forbids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum ControlState {
    /// The agent holds the page and its tool surface is live.
    AgentDriving,
    /// A viewer asked to take over. The agent still drives until it reaches a
    /// quiescent point — a handoff mid-step would tear the step in half.
    HandoffRequested,
    /// The agent has stopped and its tool surface is suspended. Nobody is
    /// driving; the lease is unclaimed.
    AwaitingHuman,
    /// Exactly one viewer drives. The agent cannot call a tool from here.
    HumanDriving,
    /// The human handed back. Autonomy resumes only once the run's
    /// preconditions are re-asserted against the page as it now stands.
    ResumeRequested,
    /// The run is parked for a person: the lease expired, the viewer vanished,
    /// a re-assertion failed, or the agent hit a blocker with nobody attached.
    /// There is no edge from here to [`ControlState::AgentDriving`].
    Suspended,
}

/// Whether the agent is inside a span that must not be interrupted.
///
/// The rotation ordering that must not be rearranged is
/// `assert candidate present -> submit` (see
/// `docs/architecture/web-login-rotation.md`). The assertion is a claim about
/// what a field contains at submit time, so a second actor touching the page
/// between the two voids it. Handoff requests raised inside the span are
/// queued rather than honoured.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum Quiescence {
    /// Between steps. Control may change hands.
    Quiescent,
    /// Inside `assert -> submit`. Control may not change hands.
    Critical,
}

/// What happened to a request to take control.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum HandoffOutcome {
    /// The agent will park at the next quiescent point.
    Accepted,
    /// Raised inside the critical section; held until the section closes. The
    /// request is not lost and the viewer is told it is pending, because a
    /// silently dropped request teaches people to mash the button.
    Queued,
}

/// How the critical section ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CriticalExit {
    /// No handoff was waiting; the agent keeps driving.
    Quiescent,
    /// A queued handoff was released; the agent will park.
    HandoffReleased,
}

/// The outcome of re-asserting a run's preconditions after human control.
///
/// Never inherited across a change of driver: the assertion is re-run, because
/// what it asserted was true of a page the agent controlled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum Reassertion {
    /// The page still satisfies what the next step needs.
    Passed,
    /// It does not. The run parks rather than guessing.
    Failed,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ControlError {
    #[error("invalid transition")]
    InvalidTransition,
    #[error("the agent is not driving")]
    NotAgentDriving,
    #[error("already inside the critical section")]
    AlreadyCritical,
    #[error("not inside the critical section")]
    NotCritical,
    #[error("control cannot change hands inside the critical section")]
    Critical,
}

impl ControlState {
    /// Whether this state may advance to `to`.
    #[must_use]
    pub fn can_transition(self, to: Self) -> bool {
        use ControlState::{
            AgentDriving, AwaitingHuman, HandoffRequested, HumanDriving, ResumeRequested, Suspended,
        };
        matches!(
            (self, to),
            (AgentDriving, HandoffRequested | AwaitingHuman | Suspended)
                | (HandoffRequested, AwaitingHuman | AgentDriving | Suspended)
                | (AwaitingHuman, HumanDriving | Suspended)
                | (HumanDriving, ResumeRequested | Suspended)
                | (ResumeRequested, AgentDriving | Suspended)
                | (Suspended, AwaitingHuman)
        )
    }

    /// Whether a human may act on the page in this state.
    #[must_use]
    pub fn human_may_drive(self) -> bool {
        matches!(self, Self::HumanDriving)
    }

    /// Whether the agent's tool surface is live in this state.
    ///
    /// False everywhere the agent is not driving: while a human holds the
    /// lease the agent has no `fill_credential` and no `submit`, so suspending
    /// the surface is a property of the state rather than a check somebody has
    /// to remember to write.
    #[must_use]
    pub fn agent_tools_live(self) -> bool {
        matches!(self, Self::AgentDriving | Self::HandoffRequested)
    }

    /// Advance to `to`.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when the edge does not exist.
    pub fn transition(self, to: Self) -> Result<Self, ControlError> {
        if self.can_transition(to) {
            Ok(to)
        } else {
            Err(ControlError::InvalidTransition)
        }
    }
}

/// A control lease over one sandboxed run.
///
/// Deliberately identity-free. *Which* viewer may attach is
/// [`crate::authorize_attach`]'s decision and depends on ownership, step-up and
/// whether the lease is already held; *whether control may move at all* is this
/// machine's, and depends only on where the run is. Keeping them apart means an
/// entitlement bug cannot produce two drivers, and a state bug cannot produce
/// an unentitled one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlLease {
    state: ControlState,
    quiescence: Quiescence,
    queued_handoff: bool,
}

impl Default for ControlLease {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlLease {
    /// A run that has just started: the agent drives, between steps.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: ControlState::AgentDriving,
            quiescence: Quiescence::Quiescent,
            queued_handoff: false,
        }
    }

    #[must_use]
    pub const fn state(self) -> ControlState {
        self.state
    }

    #[must_use]
    pub const fn quiescence(self) -> Quiescence {
        self.quiescence
    }

    /// Whether a handoff request is waiting for the critical section to close.
    #[must_use]
    pub const fn handoff_queued(self) -> bool {
        self.queued_handoff
    }

    /// Open the uninterruptible span around `assert -> submit`.
    ///
    /// # Errors
    ///
    /// [`ControlError::NotAgentDriving`] unless the agent holds the page —
    /// a run cannot enter its own critical section while parked or while a
    /// handoff has already been accepted. [`ControlError::AlreadyCritical`]
    /// on a second open, which would let one `leave_critical` close two.
    pub fn enter_critical(&mut self) -> Result<(), ControlError> {
        if self.state != ControlState::AgentDriving {
            return Err(ControlError::NotAgentDriving);
        }
        if self.quiescence == Quiescence::Critical {
            return Err(ControlError::AlreadyCritical);
        }
        self.quiescence = Quiescence::Critical;
        Ok(())
    }

    /// Close the span, releasing any handoff queued while it was open.
    ///
    /// # Errors
    ///
    /// [`ControlError::NotCritical`] when no span is open.
    pub fn leave_critical(&mut self) -> Result<CriticalExit, ControlError> {
        if self.quiescence != Quiescence::Critical {
            return Err(ControlError::NotCritical);
        }
        self.quiescence = Quiescence::Quiescent;
        if self.queued_handoff && self.state == ControlState::AgentDriving {
            self.queued_handoff = false;
            self.state = ControlState::HandoffRequested;
            return Ok(CriticalExit::HandoffReleased);
        }
        self.queued_handoff = false;
        Ok(CriticalExit::Quiescent)
    }

    /// A viewer asks to take over. Accepted at a quiescent point, queued
    /// inside the critical section.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when the agent is not driving —
    /// there is nothing to take over from a parked run, which is claimed with
    /// [`ControlLease::grant_control`] instead.
    pub fn request_handoff(&mut self) -> Result<HandoffOutcome, ControlError> {
        if self.state == ControlState::HandoffRequested {
            return Ok(HandoffOutcome::Accepted);
        }
        if self.state != ControlState::AgentDriving {
            return Err(ControlError::InvalidTransition);
        }
        if self.quiescence == Quiescence::Critical {
            self.queued_handoff = true;
            return Ok(HandoffOutcome::Queued);
        }
        self.state = ControlState::HandoffRequested;
        Ok(HandoffOutcome::Accepted)
    }

    /// The viewer changed their mind before the agent parked.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when no request is outstanding.
    pub fn withdraw_handoff(&mut self) -> Result<(), ControlError> {
        if self.queued_handoff && self.state == ControlState::AgentDriving {
            self.queued_handoff = false;
            return Ok(());
        }
        self.state = self.state.transition(ControlState::AgentDriving)?;
        Ok(())
    }

    /// The agent stops and gives up its tool surface.
    ///
    /// # Errors
    ///
    /// [`ControlError::Critical`] inside the critical section — parking there
    /// would strand a filled credential field between its assertion and its
    /// submit. [`ControlError::InvalidTransition`] when the agent was not
    /// driving.
    pub fn park(&mut self) -> Result<(), ControlError> {
        if self.quiescence == Quiescence::Critical {
            return Err(ControlError::Critical);
        }
        self.state = self.state.transition(ControlState::AwaitingHuman)?;
        self.queued_handoff = false;
        Ok(())
    }

    /// A viewer claims the unheld lease.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] unless the run is parked and
    /// unclaimed.
    pub fn grant_control(&mut self) -> Result<(), ControlError> {
        self.state = self.state.transition(ControlState::HumanDriving)?;
        Ok(())
    }

    /// The human hands the page back. Autonomy does not resume yet.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when no human holds the lease.
    pub fn release(&mut self) -> Result<(), ControlError> {
        self.state = self.state.transition(ControlState::ResumeRequested)?;
        Ok(())
    }

    /// Resume autonomy, but only on a passed re-assertion.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when the human has not released the
    /// lease.
    pub fn resume(&mut self, reassertion: Reassertion) -> Result<ControlState, ControlError> {
        let to = match reassertion {
            Reassertion::Passed => ControlState::AgentDriving,
            Reassertion::Failed => ControlState::Suspended,
        };
        self.state = self.state.transition(to)?;
        Ok(self.state)
    }

    /// Park the run for a person: lease expiry, a vanished viewer, or a
    /// blocker with nobody attached.
    ///
    /// Permitted inside the critical section, because the alternative to
    /// recording an interrupted `assert -> submit` is pretending it did not
    /// happen. A run suspended there is exactly ADR 0076 constraint 5's
    /// indeterminate outcome and reconciles rather than retrying.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when the run is already suspended.
    pub fn suspend(&mut self) -> Result<(), ControlError> {
        self.state = self.state.transition(ControlState::Suspended)?;
        self.quiescence = Quiescence::Quiescent;
        self.queued_handoff = false;
        Ok(())
    }

    /// A viewer returns to a suspended run. Lands unclaimed, never driving,
    /// and never back in the agent's hands.
    ///
    /// # Errors
    ///
    /// [`ControlError::InvalidTransition`] when the run is not suspended.
    pub fn reattach(&mut self) -> Result<(), ControlError> {
        if self.state != ControlState::Suspended {
            return Err(ControlError::InvalidTransition);
        }
        self.state = self.state.transition(ControlState::AwaitingHuman)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_watcher_takes_over_and_hands_back() {
        let mut lease = ControlLease::new();
        assert_eq!(lease.request_handoff(), Ok(HandoffOutcome::Accepted));
        assert_eq!(lease.state(), ControlState::HandoffRequested);
        lease.park().unwrap();
        assert!(!lease.state().agent_tools_live());
        lease.grant_control().unwrap();
        assert!(lease.state().human_may_drive());
        lease.release().unwrap();
        assert_eq!(
            lease.resume(Reassertion::Passed),
            Ok(ControlState::AgentDriving)
        );
    }

    #[test]
    fn handoff_inside_the_critical_section_is_queued_not_honoured() {
        let mut lease = ControlLease::new();
        lease.enter_critical().unwrap();
        assert_eq!(lease.request_handoff(), Ok(HandoffOutcome::Queued));
        // The agent is still driving: `assert -> submit` runs to completion.
        assert_eq!(lease.state(), ControlState::AgentDriving);
        assert!(lease.handoff_queued());
        assert!(lease.park().is_err());
        assert_eq!(lease.leave_critical(), Ok(CriticalExit::HandoffReleased));
        assert_eq!(lease.state(), ControlState::HandoffRequested);
        assert!(!lease.handoff_queued());
    }

    #[test]
    fn the_critical_section_cannot_be_opened_unless_the_agent_drives() {
        let mut lease = ControlLease::new();
        lease.park().unwrap();
        assert_eq!(lease.enter_critical(), Err(ControlError::NotAgentDriving));
        lease.grant_control().unwrap();
        assert_eq!(lease.enter_critical(), Err(ControlError::NotAgentDriving));
    }

    #[test]
    fn nested_critical_sections_are_refused() {
        let mut lease = ControlLease::new();
        lease.enter_critical().unwrap();
        assert_eq!(lease.enter_critical(), Err(ControlError::AlreadyCritical));
        assert_eq!(lease.leave_critical(), Ok(CriticalExit::Quiescent));
        assert_eq!(lease.leave_critical(), Err(ControlError::NotCritical));
    }

    #[test]
    fn an_expired_lease_parks_the_run_and_never_returns_it_to_the_agent() {
        let mut lease = ControlLease::new();
        lease.request_handoff().unwrap();
        lease.park().unwrap();
        lease.grant_control().unwrap();
        lease.suspend().unwrap();
        assert_eq!(lease.state(), ControlState::Suspended);
        assert_eq!(lease.grant_control(), Err(ControlError::InvalidTransition));
        lease.reattach().unwrap();
        assert_eq!(lease.state(), ControlState::AwaitingHuman);
        lease.grant_control().unwrap();
        assert!(lease.state().human_may_drive());
    }

    #[test]
    fn a_failed_reassertion_parks_rather_than_resuming() {
        let mut lease = ControlLease::new();
        lease.park().unwrap();
        lease.grant_control().unwrap();
        lease.release().unwrap();
        assert_eq!(
            lease.resume(Reassertion::Failed),
            Ok(ControlState::Suspended)
        );
    }

    #[test]
    fn suspending_inside_the_critical_section_is_allowed_and_clears_it() {
        let mut lease = ControlLease::new();
        lease.enter_critical().unwrap();
        lease.suspend().unwrap();
        assert_eq!(lease.quiescence(), Quiescence::Quiescent);
        assert_eq!(lease.state(), ControlState::Suspended);
    }

    #[test]
    fn a_withdrawn_request_leaves_the_agent_driving() {
        let mut lease = ControlLease::new();
        lease.request_handoff().unwrap();
        lease.withdraw_handoff().unwrap();
        assert_eq!(lease.state(), ControlState::AgentDriving);

        let mut queued = ControlLease::new();
        queued.enter_critical().unwrap();
        queued.request_handoff().unwrap();
        queued.withdraw_handoff().unwrap();
        assert_eq!(queued.leave_critical(), Ok(CriticalExit::Quiescent));
        assert_eq!(queued.state(), ControlState::AgentDriving);
    }

    #[test]
    fn agent_tools_are_dead_wherever_the_agent_is_not_driving() {
        for state in [
            ControlState::AwaitingHuman,
            ControlState::HumanDriving,
            ControlState::ResumeRequested,
            ControlState::Suspended,
        ] {
            assert!(!state.agent_tools_live(), "{state:?}");
        }
        assert!(ControlState::AgentDriving.agent_tools_live());
        assert!(ControlState::HandoffRequested.agent_tools_live());
    }

    #[test]
    fn autonomy_is_reachable_only_from_a_withdrawal_or_a_reassertion() {
        for state in [
            ControlState::AgentDriving,
            ControlState::AwaitingHuman,
            ControlState::HumanDriving,
            ControlState::Suspended,
        ] {
            assert!(
                !state.can_transition(ControlState::AgentDriving),
                "{state:?} must not resume autonomy directly"
            );
        }
        assert!(ControlState::HandoffRequested.can_transition(ControlState::AgentDriving));
        assert!(ControlState::ResumeRequested.can_transition(ControlState::AgentDriving));
    }
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    /// The load-bearing one: no timeout, no viewer disconnect, and no
    /// suspension can hand the page back to the model. Every edge into
    /// `AgentDriving` leaves from a state where either the agent never stopped
    /// or a re-assertion just ran.
    #[kani::proof]
    fn autonomy_resumes_only_through_a_withdrawal_or_a_reassertion() {
        let from: ControlState = kani::any();
        if from.can_transition(ControlState::AgentDriving) {
            assert!(matches!(
                from,
                ControlState::HandoffRequested | ControlState::ResumeRequested
            ));
        }
    }

    #[kani::proof]
    fn a_suspended_run_is_claimed_by_a_human_or_not_at_all() {
        let to: ControlState = kani::any();
        if ControlState::Suspended.can_transition(to) {
            assert!(matches!(to, ControlState::AwaitingHuman));
        }
    }

    #[kani::proof]
    fn agent_tools_die_the_moment_the_agent_stops_driving() {
        let state: ControlState = kani::any();
        if state.agent_tools_live() {
            assert!(!state.human_may_drive());
        }
    }

    #[kani::proof]
    fn transition_matches_can_transition() {
        let from: ControlState = kani::any();
        let to: ControlState = kani::any();
        match from.transition(to) {
            Ok(next) => {
                assert!(from.can_transition(to));
                assert_eq!(next, to);
            }
            Err(_) => assert!(!from.can_transition(to)),
        }
    }
}
