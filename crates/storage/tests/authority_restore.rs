//! Restore and failover: a rolled-back database must not resurrect authority.
//!
//! The cases are the ones an operator actually creates: a snapshot restored from
//! yesterday, a different database file put in its place, a recovery rotation, and
//! held spend capacity that must not survive it.

mod authority_support;

use chrono::Utc;
use opensesame_storage::authority::{
    BudgetScope, GenerationWitness, ProjectionMark, Reservation, ReserveOutcome,
};
use opensesame_storage::Db;

use authority_support::{entry, issue, seed_grant, seed_realm};

fn scope<'a>(organization_id: &'a str) -> BudgetScope<'a> {
    BudgetScope {
        organization_id,
        scope_kind: "root_grant",
        scope_id: "grant:root",
        unit: "api_calls",
        window_key: "2026-09-15",
    }
}

async fn seeded() -> (Db, String) {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:root").await;
    db.issue_authority(
        &issue("grant:root", &organization_id, &domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();
    (db, organization_id)
}

#[tokio::test]
async fn recovery_invalidates_pre_restore_authority_without_visiting_a_row() {
    let (db, organization_id) = seeded().await;
    assert!(db
        .fenced_authority(&organization_id, "grant:root", Utc::now())
        .await
        .unwrap()
        .is_some());

    let generation = db
        .advance_recovery_generation("restored from 2026-09-14 snapshot")
        .await
        .unwrap();
    assert_eq!(generation, 2);
    assert!(
        db.fenced_authority(&organization_id, "grant:root", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "authority issued before the restore is not authority after it"
    );
}

#[tokio::test]
async fn recovery_voids_held_capacity_and_keeps_what_was_spent() {
    let (db, organization_id) = seeded().await;
    db.set_authority_budget(&scope(&organization_id), 10)
        .await
        .unwrap();
    db.reserve_authority_budget(&Reservation {
        scope: scope(&organization_id),
        grant_id: "grant:root",
        quantity: 4,
        idempotency_key: "call:spent",
    })
    .await
    .unwrap();
    db.settle_authority_reservation(&organization_id, "call:spent", 4)
        .await
        .unwrap();
    db.reserve_authority_budget(&Reservation {
        scope: scope(&organization_id),
        grant_id: "grant:root",
        quantity: 3,
        idempotency_key: "call:held",
    })
    .await
    .unwrap();

    db.advance_recovery_generation("failover").await.unwrap();

    let (settled, outstanding, _) = db
        .authority_budget_state(&scope(&organization_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (settled, outstanding),
        (4, 0),
        "held capacity is voided; spent capacity stays spent"
    );
}

#[tokio::test]
async fn recovery_discards_projection_state() {
    let (db, organization_id) = seeded().await;
    let mark = ProjectionMark {
        store: "openfga",
        organization_id: &organization_id,
        subject_kind: "grant",
        subject_id: "grant:root",
        committed_revision: 3,
    };
    db.mark_projection_dirty(&mark).await.unwrap();
    db.record_projection_applied(&mark, Some("model:1"))
        .await
        .unwrap();
    assert!(db.projection_applied(&mark, None).await.unwrap());

    db.advance_recovery_generation("restore").await.unwrap();
    assert!(
        !db.projection_applied(&mark, None).await.unwrap(),
        "what a projection applied described a database state that no longer exists"
    );
}

#[tokio::test]
async fn a_reservation_after_recovery_needs_reissued_authority() {
    let (db, organization_id) = seeded().await;
    db.set_authority_budget(&scope(&organization_id), 10)
        .await
        .unwrap();
    db.advance_recovery_generation("restore").await.unwrap();

    assert_eq!(
        db.reserve_authority_budget(&Reservation {
            scope: scope(&organization_id),
            grant_id: "grant:root",
            quantity: 1,
            idempotency_key: "call:after",
        })
        .await
        .unwrap(),
        ReserveOutcome::Refused,
        "capacity is not spendable by authority the restore invalidated"
    );
}

#[tokio::test]
async fn a_rolled_back_database_is_fenced_against_the_outside_witness() {
    let (db, _) = seeded().await;
    let observed = db.operational_generation().await.unwrap();
    db.assert_operational_generation(&GenerationWitness {
        database_identity: &observed.database_identity,
        generation: observed.generation,
    })
    .await
    .unwrap();

    // The witness saw generation 3; this file is serving 1. That is a snapshot from
    // before two recoveries, and it must not serve authority.
    let stale = db
        .assert_operational_generation(&GenerationWitness {
            database_identity: &observed.database_identity,
            generation: observed.generation + 2,
        })
        .await;
    assert!(stale.is_err());
    assert!(stale
        .unwrap_err()
        .to_string()
        .contains("recovery rotation is required"));
}

#[tokio::test]
async fn a_different_database_file_is_not_the_same_authority() {
    let (db, _) = seeded().await;
    let mismatched = db
        .assert_operational_generation(&GenerationWitness {
            database_identity: "0123456789abcdef0123456789abcdef",
            generation: 1,
        })
        .await;
    assert!(
        mismatched.is_err(),
        "an identity the witness never recorded is a different database"
    );
}
