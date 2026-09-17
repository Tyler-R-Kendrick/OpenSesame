//! FIX-FAMILY — snapshot exclusion and guardian/vault separation (domain path).

use crate::access_domain::{
    AccessDomainForest, ControlAssignment, ControlIndex, ControlScope, DomainRole, Realm,
};
use crate::cohort_fixture::{fixture, graph_with_team, t0};
use crate::{
    AdmissionBasis, AdmissionMode, CohortSnapshot, CohortSnapshotId, DomainControlId, DomainError,
    PermissionEntry, PermissionSet, PrincipalId, ProjectId, SessionId, SessionMembership,
    SessionMode, VaultId,
};

#[test]
fn fix_family_snapshot_excludes_a_late_add() {
    // Start with Dana alone on the team, take a snapshot, then add Ridley live.
    let frozen = fixture(AdmissionMode::Snapshot);
    let only_dana = frozen.without_ridley();
    let resolution = only_dana.resolve(frozen.cohort.id, t0()).unwrap();
    let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();
    assert!(snapshot.eligibility(frozen.dana).is_some());
    assert!(snapshot.eligibility(frozen.ridley).is_none());

    let grown = graph_with_team(only_dana, frozen.team_id, &[frozen.dana, frozen.ridley]);
    let live = grown.resolve(frozen.cohort.id, t0()).unwrap();
    assert!(live.eligibility(frozen.ridley).is_some());

    assert!(
        snapshot.eligibility(frozen.ridley).is_none(),
        "a late add must stay outside the reviewed snapshot"
    );
    assert!(
        AdmissionBasis::Snapshot(&snapshot)
            .eligibility(frozen.ridley)
            .is_none(),
        "snapshot admission must deny the late principal"
    );
}

#[test]
fn fix_family_guardian_supervision_does_not_read_vault_secrets() {
    let mut forest = AccessDomainForest::new(Realm::standard(None, ProjectId::new()));
    let household = forest
        .create_root(crate::AccessDomainId::new(), "household", "Household", t0())
        .expect("root");
    let guardian = PrincipalId::new();
    let mut control = ControlIndex::new();
    control
        .insert(
            &forest,
            ControlAssignment {
                id: DomainControlId::new(),
                domain_id: household,
                principal_id: guardian,
                role: DomainRole::Owner,
                scope: ControlScope::Subtree,
            },
        )
        .expect("guardian owns the household");

    let held = control
        .effective_control(&forest, household, guardian)
        .expect("resolve")
        .expect("guardian has control");
    assert!(held.role.can_administer());

    // Supervision is control-plane only. No SessionGrant was minted, so vault
    // reach is empty — Owner does not unwrap ciphertext by itself.
    let empty = PermissionSet::empty();
    assert!(!empty.permits("reveal", &format!("vault:{}", VaultId::new())));
    assert!(!empty.permits("export", "secret:participant"));

    let observer = SessionMembership::new(
        SessionId::new(),
        guardian,
        SessionMode::Observer,
        PrincipalId::new(),
        t0(),
    );
    assert!(
        matches!(
            observer.assert_may_hold_grant(),
            Err(DomainError::SessionObserverHoldsNoGrant)
        ),
        "even an Owner seated as observer must not receive a vault key"
    );

    let browse = PermissionSet::new(vec![
        PermissionEntry::new(&["browse"], &["device:tablet"]).unwrap()
    ])
    .unwrap();
    assert!(browse.permits("browse", "device:tablet"));
    assert!(!browse.permits("reveal", "device:tablet"));
    assert!(!browse.permits("export", "device:tablet"));
}
