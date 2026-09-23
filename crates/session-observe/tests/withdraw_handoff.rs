//! `withdraw_handoff` is the viewer's "never mind" before the agent parks. It
//! must not double as a way back to autonomy from anywhere else: a run a human
//! released sits in `ResumeRequested` until a re-assertion passes (ADR 0081 §6).

use opensesame_session_observe::{ControlError, ControlLease, ControlState, Reassertion};

fn released_by_a_human() -> ControlLease {
    let mut lease = ControlLease::new();
    lease.request_handoff().unwrap();
    lease.park().unwrap();
    lease.grant_control().unwrap();
    lease.release().unwrap();
    assert_eq!(lease.state(), ControlState::ResumeRequested);
    lease
}

#[test]
fn a_released_lease_cannot_withdraw_its_way_back_to_the_agent() {
    let mut lease = released_by_a_human();
    assert_eq!(
        lease.withdraw_handoff(),
        Err(ControlError::InvalidTransition)
    );
    assert_eq!(lease.state(), ControlState::ResumeRequested);
    assert!(!lease.state().agent_tools_live());
}

#[test]
fn only_a_passed_reassertion_returns_a_released_lease_to_the_agent() {
    let mut failed = released_by_a_human();
    assert_eq!(
        failed.resume(Reassertion::Failed),
        Ok(ControlState::Suspended)
    );

    let mut passed = released_by_a_human();
    assert_eq!(
        passed.resume(Reassertion::Passed),
        Ok(ControlState::AgentDriving)
    );
}

#[test]
fn withdrawal_is_refused_wherever_no_request_is_outstanding() {
    let mut driving = ControlLease::new();
    assert_eq!(
        driving.withdraw_handoff(),
        Err(ControlError::InvalidTransition)
    );

    let mut parked = ControlLease::new();
    parked.request_handoff().unwrap();
    parked.park().unwrap();
    assert_eq!(
        parked.withdraw_handoff(),
        Err(ControlError::InvalidTransition)
    );

    let mut held = ControlLease::new();
    held.request_handoff().unwrap();
    held.park().unwrap();
    held.grant_control().unwrap();
    assert_eq!(
        held.withdraw_handoff(),
        Err(ControlError::InvalidTransition)
    );

    let mut suspended = ControlLease::new();
    suspended.suspend().unwrap();
    assert_eq!(
        suspended.withdraw_handoff(),
        Err(ControlError::InvalidTransition)
    );
}

#[test]
fn an_outstanding_request_is_still_withdrawable() {
    let mut lease = ControlLease::new();
    lease.request_handoff().unwrap();
    assert_eq!(lease.withdraw_handoff(), Ok(()));
    assert_eq!(lease.state(), ControlState::AgentDriving);
}
