use crate::duress::hold::HoldDuration;
use crate::duress::ops_core::*;
use crate::duress::{DurableEpochs, DuressAuthorityStore, HoldPhase};
use opensesame_authz::duress::{BoundaryOp, CeilingVerdict, DispatchState};

fn epochs() -> DurableEpochs {
        DurableEpochs::new(1, 2, 3)
}

#[test]
fn purpose_mismatch_fails_closed() {
        let mut store = DuressAuthorityStore::new();
        let err = accept_independent_hold(
            &mut store,
            "wrong.purpose",
            "h1",
            "auth-1",
            "inc-1",
            epochs(),
            HoldDuration::Indefinite,
            1000,
            "ceiling-1",
        )
        .expect_err("purpose");
        assert_eq!(err.code(), "purpose_mismatch");
}

#[test]
fn timed_hold_delay_never_auto_unlocks() {
        let mut store = DuressAuthorityStore::new();
        accept_independent_hold(
            &mut store,
            DuressPurpose::AcceptIndependentHold.as_str(),
            "h1",
            "auth-1",
            "inc-1",
            epochs(),
            HoldDuration::DurationMs(5_000),
            1_000,
            "ceiling-1",
        )
        .expect("accept");

        // Before delay: recovery refused; capabilities still held.
        let early = request_recovery(
            &mut store,
            DuressPurpose::RequestRecovery.as_str(),
            "inc-1",
            2_000,
        );
        assert!(matches!(early, Err(DuressOpError::RecoveryNotAdmitted)));
        assert!(store.hold("inc-1").unwrap().capabilities_held());

        // After delay: recovery may be requested, but mint/sign still denied.
        request_recovery(
            &mut store,
            DuressPurpose::RequestRecovery.as_str(),
            "inc-1",
            7_000,
        )
        .expect("recovery after delay");
        assert_eq!(
            store.incident_state("inc-1"),
            Some(IncidentState::RecoveryRequested)
        );
        let v = gate_boundary(
            &store,
            Some("inc-1"),
            BoundaryOp::Mint,
            &DispatchState::NotStarted,
            Some(epochs()),
        );
        assert!(matches!(
            v,
            CeilingVerdict::Deny {
                code: "duress_deny_ceiling",
                ..
            }
        ));

        // Clock alone never resolves.
        store.hold_mut("inc-1").unwrap().observe_clock(99_000);
        assert!(store.hold("inc-1").unwrap().capabilities_held());
        assert_ne!(
            store.hold("inc-1").unwrap().phase,
            HoldPhase::Resolved
        );
}

#[test]
fn only_matching_authority_and_epochs_resolve() {
        let mut store = DuressAuthorityStore::new();
        accept_independent_hold(
            &mut store,
            DuressPurpose::AcceptIndependentHold.as_str(),
            "h1",
            "auth-1",
            "inc-1",
            epochs(),
            HoldDuration::Indefinite,
            1_000,
            "ceiling-1",
        )
        .expect("accept");

        assert!(matches!(
            resolve_recovery(
                &mut store,
                DuressPurpose::ResolveRecovery.as_str(),
                "inc-1",
                "auth-OTHER",
                epochs(),
            ),
            Err(DuressOpError::AuthorityMismatch)
        ));
        assert!(matches!(
            resolve_recovery(
                &mut store,
                DuressPurpose::ResolveRecovery.as_str(),
                "inc-1",
                "auth-1",
                DurableEpochs::new(1, 2, 99),
            ),
            Err(DuressOpError::EpochMismatch)
        ));

        resolve_recovery(
            &mut store,
            DuressPurpose::ResolveRecovery.as_str(),
            "inc-1",
            "auth-1",
            epochs(),
        )
        .expect("resolve");
        assert!(!store.hold("inc-1").unwrap().capabilities_held());
        let v = gate_boundary(
            &store,
            Some("inc-1"),
            BoundaryOp::Invoke,
            &DispatchState::NotStarted,
            Some(epochs()),
        );
        assert_eq!(v, CeilingVerdict::Allow);
}

#[test]
fn quarantine_is_epoch_bound() {
        let mut store = DuressAuthorityStore::new();
        accept_independent_hold(
            &mut store,
            DuressPurpose::AcceptIndependentHold.as_str(),
            "h1",
            "auth-1",
            "inc-1",
            epochs(),
            HoldDuration::Indefinite,
            1_000,
            "ceiling-1",
        )
        .expect("accept");
        quarantine_peer(
            &mut store,
            DuressPurpose::QuarantinePeer.as_str(),
            "peer-a",
            "inc-1",
            epochs(),
            1_100,
        )
        .expect("quarantine");
        assert!(store.is_peer_quarantined("peer-a"));
        assert!(matches!(
            quarantine_peer(
                &mut store,
                DuressPurpose::QuarantinePeer.as_str(),
                "peer-b",
                "inc-1",
                DurableEpochs::new(9, 9, 9),
                1_200,
            ),
            Err(DuressOpError::EpochMismatch)
        ));
}

#[test]
fn browser_local_paths_need_no_host_incident() {
        // No incident registered ⇒ no ceiling ⇒ allow (Pages local).
        let store = DuressAuthorityStore::new();
        let v = gate_boundary(
            &store,
            None,
            BoundaryOp::Authorize,
            &DispatchState::NotStarted,
            None,
        );
        assert_eq!(v, CeilingVerdict::Allow);
}

#[test]
fn already_dispatched_survives_active_hold() {
        let mut store = DuressAuthorityStore::new();
        accept_independent_hold(
            &mut store,
            DuressPurpose::AcceptIndependentHold.as_str(),
            "h1",
            "auth-1",
            "inc-1",
            epochs(),
            HoldDuration::Indefinite,
            1_000,
            "ceiling-1",
        )
        .expect("accept");
        let dispatch = DispatchState::AlreadyDispatched {
            dispatch_id: "d-1".into(),
            op: BoundaryOp::Sign,
            dispatched_at_ms: 500,
        };
        let v = gate_boundary(&store, Some("inc-1"), BoundaryOp::Sign, &dispatch, Some(epochs()));
        assert!(matches!(
            v,
            CeilingVerdict::AlreadyDispatched {
                dispatch_id,
                op: BoundaryOp::Sign,
                ..
            } if dispatch_id == "d-1"
        ));
}
