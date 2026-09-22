//! FIX-CONTRACTOR — correlated `PermissionEntry` and snapshot admission (domain).

use crate::cohort_fixture::{fixture, t0};
use crate::{
    AdmissionBasis, AdmissionMode, CohortSnapshot, CohortSnapshotId, PermissionEntry, PermissionSet,
};

#[test]
fn fix_contractor_correlated_entries_do_not_permit_write_a() {
    let set = PermissionSet::new(vec![
        PermissionEntry::new(&["logs.read"], &["resource:A"]).unwrap(),
        PermissionEntry::new(&["ticket.comment"], &["resource:B"]).unwrap(),
    ])
    .unwrap();

    assert!(set.permits("logs.read", "resource:A"));
    assert!(set.permits("ticket.comment", "resource:B"));
    assert!(
        !set.permits("logs.write", "resource:A"),
        "logs.read A + ticket.comment B must not become logs.write A"
    );
    assert!(
        !set.permits("ticket.comment", "resource:A"),
        "ticket.comment stays bound to B"
    );
    assert!(!set.permits("logs.read", "resource:B"));
}

#[test]
fn fix_contractor_snapshot_roster_add_is_denied() {
    let frozen = fixture(AdmissionMode::Snapshot);
    let only_dana = frozen.without_ridley();
    let resolution = only_dana.resolve(frozen.cohort.id, t0()).unwrap();
    let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();

    // Ridley is the third contractor added after snapshot approval.
    assert!(snapshot.eligibility(frozen.ridley).is_none());
    assert!(
        AdmissionBasis::Snapshot(&snapshot)
            .eligibility(frozen.ridley)
            .is_none(),
        "a post-snapshot roster add must be denied"
    );
}
