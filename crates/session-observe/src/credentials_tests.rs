use std::cell::RefCell;

use super::*;
use crate::lease::HandoffOutcome;

/// Records every revocation, standing in for the surrogate proxy's ledger.
#[derive(Default)]
struct Ledger {
    revoked: RefCell<Vec<String>>,
}

impl RunCredentials for Ledger {
    fn revoke(&self, run_id: &str) -> usize {
        self.revoked.borrow_mut().push(run_id.to_owned());
        1
    }
}

fn misdirected(run: &str) -> RunNotice<'_> {
    RunNotice {
        event_type: MISDIRECTED_EVENT,
        run_id: Some(run),
    }
}

#[test]
fn parking_a_run_revokes_its_surrogates() {
    let ledger = Ledger::default();
    let mut lease = ControlLease::new();
    assert_eq!(park_and_revoke(&mut lease, "run-1", &ledger), Ok(1));
    assert_eq!(lease.state(), ControlState::AwaitingHuman);
    assert_eq!(*ledger.revoked.borrow(), vec!["run-1".to_owned()]);
}

#[test]
fn a_refused_park_revokes_nothing_because_the_agent_still_drives() {
    let ledger = Ledger::default();
    let mut lease = ControlLease::new();
    lease.enter_critical().unwrap();
    assert_eq!(
        park_and_revoke(&mut lease, "run-1", &ledger),
        Err(ControlError::Critical)
    );
    assert!(ledger.revoked.borrow().is_empty());
}

#[test]
fn suspending_inside_the_critical_section_revokes() {
    let ledger = Ledger::default();
    let mut lease = ControlLease::new();
    lease.enter_critical().unwrap();
    assert_eq!(suspend_and_revoke(&mut lease, "run-1", &ledger), Ok(1));
    assert_eq!(lease.state(), ControlState::Suspended);
}

#[test]
fn ending_a_run_always_revokes() {
    let ledger = Ledger::default();
    assert_eq!(end_and_revoke("run-9", &ledger), 1);
    assert_eq!(*ledger.revoked.borrow(), vec!["run-9".to_owned()]);
}

#[test]
fn the_default_credentials_revoke_nothing() {
    let mut lease = ControlLease::new();
    assert_eq!(
        park_and_revoke(&mut lease, "run-1", &NoRunCredentials),
        Ok(0)
    );
    assert_eq!(end_and_revoke("run-1", &NoRunCredentials), 0);
}

#[test]
fn a_misdirected_surrogate_parks_a_watched_run_and_revokes_it() {
    let ledger = Ledger::default();
    let mut lease = ControlLease::new();
    let verdict = tripwire_verdict(&[misdirected("run-1")], "run-1", true, lease);
    assert_eq!(verdict, TripwireVerdict::Park);
    assert_eq!(
        apply_tripwire(verdict, &mut lease, "run-1", &ledger),
        Ok(Some(1))
    );
    assert!(!lease.state().agent_tools_live());
    assert_eq!(*ledger.revoked.borrow(), vec!["run-1".to_owned()]);
}

#[test]
fn a_misdirected_surrogate_mid_submit_suspends_rather_than_parks() {
    let mut lease = ControlLease::new();
    lease.enter_critical().unwrap();
    let verdict = tripwire_verdict(&[misdirected("run-1")], "run-1", true, lease);
    assert_eq!(verdict, TripwireVerdict::Suspend);
    let ledger = Ledger::default();
    apply_tripwire(verdict, &mut lease, "run-1", &ledger).unwrap();
    assert_eq!(lease.state(), ControlState::Suspended);
}

#[test]
fn a_pending_handoff_is_still_the_agent_driving_so_it_parks() {
    let mut lease = ControlLease::new();
    assert_eq!(lease.request_handoff(), Ok(HandoffOutcome::Accepted));
    let verdict = tripwire_verdict(&[misdirected("run-1")], "run-1", true, lease);
    assert_eq!(verdict, TripwireVerdict::Park);
}

#[test]
fn an_unwatched_run_is_not_parked_by_the_rule() {
    let lease = ControlLease::new();
    assert_eq!(
        tripwire_verdict(&[misdirected("run-1")], "run-1", false, lease),
        TripwireVerdict::Continue
    );
}

#[test]
fn another_runs_tripwire_never_parks_this_one() {
    let lease = ControlLease::new();
    let notices = [misdirected("run-2")];
    assert_eq!(
        tripwire_verdict(&notices, "run-1", true, lease),
        TripwireVerdict::Continue
    );
}

#[test]
fn other_fences_and_unattributed_notices_do_not_park() {
    let lease = ControlLease::new();
    let notices = [
        RunNotice {
            event_type: "surrogate.misplaced",
            run_id: Some("run-1"),
        },
        RunNotice {
            event_type: MISDIRECTED_EVENT,
            run_id: None,
        },
    ];
    assert_eq!(
        tripwire_verdict(&notices, "run-1", true, lease),
        TripwireVerdict::Continue
    );
}

#[test]
fn a_run_a_human_already_holds_has_nothing_to_stop() {
    let mut lease = ControlLease::new();
    lease.park().unwrap();
    lease.grant_control().unwrap();
    assert_eq!(
        tripwire_verdict(&[misdirected("run-1")], "run-1", true, lease),
        TripwireVerdict::Continue
    );
}

#[test]
fn the_parking_event_is_the_frozen_agent_events_name() {
    assert_eq!(
        MISDIRECTED_EVENT,
        opensesame_agent_events::surrogate::EVENT_SURROGATE_MISDIRECTED
    );
}
