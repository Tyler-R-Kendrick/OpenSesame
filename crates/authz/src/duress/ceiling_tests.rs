use crate::duress::ceiling_core::*;
use opensesame_domain::AuthorityOperation;
use std::collections::BTreeSet;

fn epochs() -> EpochTriple {
    EpochTriple {
        policy_epoch: 3,
        key_epoch: 7,
        incident_epoch: 11,
    }
}

#[test]
fn absent_ceiling_allows_all_boundaries() {
    for op in [
        BoundaryOp::Authorize,
        BoundaryOp::Mint,
        BoundaryOp::Renew,
        BoundaryOp::Invoke,
        BoundaryOp::Sign,
        BoundaryOp::KeyRelease,
    ] {
        let v = evaluate_deny_ceiling(None, op, &DispatchState::NotStarted, Some(epochs()));
        assert_eq!(v, CeilingVerdict::Allow);
        assert!(v.permits_new_dispatch());
    }
}

#[test]
fn deny_all_blocks_authorize_mint_renew_invoke_sign_key_release() {
    let ceiling = DenyCeiling::deny_all_boundaries("ceiling-locked", epochs());
    for op in [
        BoundaryOp::Authorize,
        BoundaryOp::Mint,
        BoundaryOp::Renew,
        BoundaryOp::Invoke,
        BoundaryOp::Sign,
        BoundaryOp::KeyRelease,
    ] {
        let v = evaluate_deny_ceiling(
            Some(&ceiling),
            op,
            &DispatchState::NotStarted,
            Some(epochs()),
        );
        assert!(
            matches!(
                v,
                CeilingVerdict::Deny {
                    code: "duress_deny_ceiling",
                    ..
                }
            ),
            "{op:?}"
        );
        assert!(!v.permits_new_dispatch());
    }
}

#[test]
fn already_dispatched_is_never_rewritten_as_deny() {
    let ceiling = DenyCeiling::deny_all_boundaries("ceiling-locked", epochs());
    let dispatch = DispatchState::AlreadyDispatched {
        dispatch_id: "disp-9".into(),
        op: BoundaryOp::Mint,
        dispatched_at_ms: 1_700_000_000_000,
    };
    let v = evaluate_deny_ceiling(Some(&ceiling), BoundaryOp::Mint, &dispatch, Some(epochs()));
    assert_eq!(
        v,
        CeilingVerdict::AlreadyDispatched {
            dispatch_id: "disp-9".into(),
            op: BoundaryOp::Mint,
            dispatched_at_ms: 1_700_000_000_000,
        }
    );
    assert_eq!(v.code(), Some("already_dispatched"));
    assert!(!v.permits_new_dispatch());
}

#[test]
fn stale_epochs_fail_closed() {
    let ceiling = DenyCeiling::deny_all_boundaries("ceiling-locked", epochs());
    let presented = EpochTriple {
        policy_epoch: 3,
        key_epoch: 7,
        incident_epoch: 99,
    };
    let v = evaluate_deny_ceiling(
        Some(&ceiling),
        BoundaryOp::Invoke,
        &DispatchState::NotStarted,
        Some(presented),
    );
    assert!(matches!(
        v,
        CeilingVerdict::StaleEpochs {
            code: "stale_duress_epochs",
            ..
        }
    ));
}

#[test]
fn missing_epochs_with_active_ceiling_fail_closed() {
    let ceiling = DenyCeiling::deny_all_boundaries("ceiling-locked", epochs());
    let v = evaluate_deny_ceiling(
        Some(&ceiling),
        BoundaryOp::Sign,
        &DispatchState::NotStarted,
        None,
    );
    assert!(matches!(
        v,
        CeilingVerdict::StaleEpochs {
            code: "missing_duress_epochs",
            ..
        }
    ));
}

#[test]
fn selective_ceiling_allows_non_denied_ops() {
    let mut denied = BTreeSet::new();
    denied.insert(BoundaryOp::KeyRelease);
    denied.insert(BoundaryOp::Mint);
    let ceiling = DenyCeiling {
        ceiling_ref: "ceiling-restricted".into(),
        denied,
        epochs: epochs(),
    };
    assert!(matches!(
        evaluate_deny_ceiling(
            Some(&ceiling),
            BoundaryOp::Invoke,
            &DispatchState::NotStarted,
            Some(epochs())
        ),
        CeilingVerdict::Allow
    ));
    assert!(matches!(
        evaluate_deny_ceiling(
            Some(&ceiling),
            BoundaryOp::Mint,
            &DispatchState::NotStarted,
            Some(epochs())
        ),
        CeilingVerdict::Deny { .. }
    ));
}

#[test]
fn authority_operation_mapping_covers_host_boundaries() {
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Authorize),
        Some(BoundaryOp::Authorize)
    );
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Mint),
        Some(BoundaryOp::Mint)
    );
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Lease),
        Some(BoundaryOp::Renew)
    );
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Invoke),
        Some(BoundaryOp::Invoke)
    );
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Sign),
        Some(BoundaryOp::Sign)
    );
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Resolve),
        Some(BoundaryOp::KeyRelease)
    );
    assert_eq!(
        BoundaryOp::from_authority_operation(AuthorityOperation::Describe),
        None
    );
}
