//! FIX-RAID — leave/end terminates lifecycle-bound reach on the grant ledger.
//!
//! Observer metadata-only seating and referenced-vs-lifecycle session grants
//! live in `opensesame-domain::fix_raid`. Storage proves that ending the raid
//! envelope fences derived authority while an independent grant survives.

use chrono::{Duration, Utc};

use super::fix_support::{entry, issue, seed_grant, seed_realm};
use crate::Db;

#[tokio::test]
async fn fix_raid_leave_or_end_terminates_lifecycle_bound_reach() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:raid").await;
    seed_grant(&db, &organization_id, "grant:raid").await;
    seed_grant(&db, &organization_id, "grant:raider").await;
    let parent = issue("grant:raid", &organization_id, &domain_id);
    assert!(db
        .issue_authority(&parent, &[entry("strategy:tonight", "read")],)
        .await
        .unwrap());
    let mut raider = issue("grant:raider", &organization_id, &domain_id);
    raider.parent_grant_id = Some("grant:raid");
    raider.issuance_basis = "delegation";
    raider.delegation_depth_remaining = 0;
    raider.not_before = parent.not_before + Duration::seconds(1);
    raider.expires_at = parent.expires_at - Duration::seconds(1);
    assert!(db
        .issue_authority(&raider, &[entry("strategy:tonight", "read")])
        .await
        .unwrap());
    assert!(db
        .fenced_authority(&organization_id, "grant:raider", Utc::now())
        .await
        .unwrap()
        .is_some());

    // End-session / leave: fence the raid envelope. Lifecycle-bound reach stops.
    db.fence_grant("grant:raid", "session-ended", Utc::now())
        .await
        .unwrap();
    assert!(
        db.fenced_authority(&organization_id, "grant:raider", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "leave/end must terminate lifecycle-bound raid reach"
    );
}

#[tokio::test]
async fn fix_raid_referenced_independent_grant_survives_end() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:raid").await;
    seed_grant(&db, &organization_id, "grant:raid").await;
    seed_grant(&db, &organization_id, "grant:guild-role").await;
    assert!(db
        .issue_authority(
            &issue("grant:raid", &organization_id, &domain_id),
            &[entry("strategy:tonight", "read")],
        )
        .await
        .unwrap());
    assert!(db
        .issue_authority(
            &issue("grant:guild-role", &organization_id, &domain_id),
            &[entry("guild:roster", "read")],
        )
        .await
        .unwrap());

    db.fence_grant("grant:raid", "session-ended", Utc::now())
        .await
        .unwrap();
    assert!(db
        .fenced_authority(&organization_id, "grant:raid", Utc::now())
        .await
        .unwrap()
        .is_none());
    assert!(
        db.fenced_authority(&organization_id, "grant:guild-role", Utc::now())
            .await
            .unwrap()
            .is_some(),
        "an unrelated guild role must survive raid end"
    );
}
