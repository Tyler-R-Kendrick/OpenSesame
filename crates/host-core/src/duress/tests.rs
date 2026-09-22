use super::*;
use opensesame_authz::duress::{BoundaryOp, CeilingVerdict, DispatchState};

#[test]
fn hold_delay_never_auto_unlocks() {
    let mut store = DuressAuthorityStore::new();
    let epochs = DurableEpochs::new(1, 1, 1);
    let hold = accept_independent_hold(
        &mut store,
        DuressPurpose::AcceptIndependentHold.as_str(),
        "h1",
        "auth-1",
        "i1",
        epochs,
        HoldDuration::DurationMs(5_000),
        1_000,
        "ceil-1",
    )
    .expect("accept");
    assert!(hold.capabilities_held());

    let mut held = store.hold("i1").unwrap().clone();
    held.observe_clock(10_000);
    assert_eq!(held.phase, HoldPhase::DelayElapsed);
    assert!(held.capabilities_held());
    assert!(admits_recovery_attempt(&held));
}

#[test]
fn resolution_requires_matching_authority_and_epochs() {
    let mut store = DuressAuthorityStore::new();
    let epochs = DurableEpochs::new(1, 2, 3);
    accept_independent_hold(
        &mut store,
        DuressPurpose::AcceptIndependentHold.as_str(),
        "h1",
        "auth-1",
        "i1",
        epochs,
        HoldDuration::Indefinite,
        0,
        "ceil-1",
    )
    .unwrap();

    assert_eq!(
        resolve_recovery(
            &mut store,
            DuressPurpose::ResolveRecovery.as_str(),
            "i1",
            "wrong",
            epochs,
        )
        .unwrap_err()
        .code(),
        "authority_mismatch"
    );

    resolve_recovery(
        &mut store,
        DuressPurpose::ResolveRecovery.as_str(),
        "i1",
        "auth-1",
        epochs,
    )
    .unwrap();
    assert_eq!(store.hold("i1").unwrap().phase, HoldPhase::Resolved);
}

#[test]
fn already_dispatched_not_rewritten_as_deny() {
    let mut store = DuressAuthorityStore::new();
    let epochs = DurableEpochs::new(1, 1, 1);
    accept_independent_hold(
        &mut store,
        DuressPurpose::AcceptIndependentHold.as_str(),
        "h1",
        "auth-1",
        "i1",
        epochs,
        HoldDuration::Indefinite,
        0,
        "ceil-1",
    )
    .unwrap();

    let verdict = gate_boundary(
        &store,
        Some("i1"),
        BoundaryOp::Mint,
        &DispatchState::AlreadyDispatched {
            dispatch_id: "d1".into(),
            op: BoundaryOp::Mint,
            dispatched_at_ms: 1,
        },
        Some(epochs),
    );
    assert!(matches!(verdict, CeilingVerdict::AlreadyDispatched { .. }));
}

#[test]
fn browser_local_needs_no_host_incident() {
    let store = DuressAuthorityStore::new();
    let verdict = gate_boundary(
        &store,
        None,
        BoundaryOp::Invoke,
        &DispatchState::NotStarted,
        None,
    );
    assert_eq!(verdict, CeilingVerdict::Allow);
}
