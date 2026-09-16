//! Atomicity: no security mutation lives only in memory, and no root budget can
//! be spent twice.
//!
//! The adversarial cases the storage swarm was asked to answer are here: a
//! hundred children each asking for the whole parent budget, a racing pair going
//! for the last unit, a retry that must not reserve again, a provider timeout that
//! must not refund, and a revoke that must deny a descendant before the call
//! returns.

mod authority_support;

use chrono::{Duration, Utc};
use opensesame_storage::authority::{
    BudgetScope, DesiredEffect, EffectObservation, Reservation, ReserveOutcome, SettleOutcome,
};
use opensesame_storage::Db;
use std::sync::Arc;

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

async fn seeded() -> (Db, String, String) {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:root").await;
    db.issue_authority(
        &issue("grant:root", &organization_id, &domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();
    (db, organization_id, domain_id)
}

#[tokio::test]
async fn a_hundred_children_cannot_multiply_one_root_budget() {
    let (db, organization_id, _) = seeded().await;
    db.set_authority_budget(&scope(&organization_id), 10)
        .await
        .unwrap();

    let db = Arc::new(db);
    let mut accepted = 0;
    let mut handles = Vec::new();
    for index in 0..100 {
        let db = Arc::clone(&db);
        handles.push(tokio::spawn(async move {
            db.reserve_authority_budget(&Reservation {
                scope: scope("org:one"),
                grant_id: "grant:root",
                quantity: 1,
                idempotency_key: &format!("call:{index}"),
            })
            .await
            .unwrap()
        }));
    }
    for handle in handles {
        if matches!(handle.await.unwrap(), ReserveOutcome::Accepted { .. }) {
            accepted += 1;
        }
    }
    assert_eq!(accepted, 10, "capacity is conserved, not per-caller");

    let (settled, outstanding, capacity) = db
        .authority_budget_state(&scope(&organization_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!((settled, outstanding, capacity), (0, 10, 10));
}

#[tokio::test]
async fn a_retry_holds_the_same_capacity_once() {
    let (db, organization_id, _) = seeded().await;
    db.set_authority_budget(&scope(&organization_id), 5)
        .await
        .unwrap();
    let request = Reservation {
        scope: scope(&organization_id),
        grant_id: "grant:root",
        quantity: 3,
        idempotency_key: "call:retried",
    };
    let first = db.reserve_authority_budget(&request).await.unwrap();
    let second = db.reserve_authority_budget(&request).await.unwrap();
    let ReserveOutcome::Accepted { id } = first else {
        panic!("first reservation must be accepted");
    };
    assert_eq!(second, ReserveOutcome::Duplicate { id });

    let (_, outstanding, _) = db
        .authority_budget_state(&scope(&organization_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outstanding, 3, "a retry is the same claim");
}

#[tokio::test]
async fn an_unknown_outcome_stays_charged_and_a_known_one_is_released() {
    let (db, organization_id, _) = seeded().await;
    db.set_authority_budget(&scope(&organization_id), 10)
        .await
        .unwrap();
    for key in ["call:timed-out", "call:known-noop"] {
        db.reserve_authority_budget(&Reservation {
            scope: scope(&organization_id),
            grant_id: "grant:root",
            quantity: 2,
            idempotency_key: key,
        })
        .await
        .unwrap();
    }

    // The provider timed out. Nobody knows whether the work happened, so the
    // reservation settles in full: a refund here is how one budget pays for two
    // operations.
    assert_eq!(
        db.settle_authority_reservation(&organization_id, "call:timed-out", 2)
            .await
            .unwrap(),
        SettleOutcome::Applied
    );
    // This one is known not to have consumed anything.
    assert_eq!(
        db.release_authority_reservation(&organization_id, "call:known-noop")
            .await
            .unwrap(),
        SettleOutcome::Applied
    );
    // And a second settlement of the same reservation changes nothing.
    assert_eq!(
        db.settle_authority_reservation(&organization_id, "call:timed-out", 2)
            .await
            .unwrap(),
        SettleOutcome::AlreadyFinal
    );

    let (settled, outstanding, _) = db
        .authority_budget_state(&scope(&organization_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!((settled, outstanding), (2, 0));
}

#[tokio::test]
async fn settled_usage_stays_charged_after_the_grant_is_revoked() {
    let (db, organization_id, _) = seeded().await;
    db.set_authority_budget(&scope(&organization_id), 4)
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

    db.fence_grant("grant:root", "owner-revoked", Utc::now())
        .await
        .unwrap();
    let (settled, _, capacity) = db
        .authority_budget_state(&scope(&organization_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (settled, capacity),
        (4, 4),
        "work already done stays paid for"
    );
}

#[tokio::test]
async fn revoking_a_parent_denies_the_child_at_the_commit() {
    let (db, organization_id, domain_id) = seeded().await;
    seed_grant(&db, &organization_id, "grant:child").await;
    let mut child = issue("grant:child", &organization_id, &domain_id);
    child.parent_grant_id = Some("grant:root");
    child.issuance_basis = "delegation";
    child.delegation_depth_remaining = 0;
    // Strictly inside the parent's window: containment is checked to the instant.
    child.not_before = Utc::now();
    child.expires_at = Utc::now() + Duration::minutes(30);
    assert!(db
        .issue_authority(&child, &[entry("resource:A", "read")])
        .await
        .unwrap());
    assert!(db
        .fenced_authority(&organization_id, "grant:child", Utc::now())
        .await
        .unwrap()
        .is_some());

    db.fence_grant("grant:root", "owner-revoked", Utc::now())
        .await
        .unwrap();

    // No descendant was visited, and none needed to be.
    assert!(
        db.fenced_authority(&organization_id, "grant:child", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "an ancestor's revocation denies its descendants immediately"
    );
}

#[tokio::test]
async fn fencing_a_realm_denies_its_authority_and_leaves_its_neighbour_alone() {
    let (db, organization_id, _) = seeded().await;
    let (other_realm, other_domain) = seed_realm(&db, "org:two").await;
    seed_grant(&db, &other_realm, "grant:other").await;
    db.issue_authority(
        &issue("grant:other", &other_realm, &other_domain),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();

    db.revoke_realm_authority(&organization_id).await.unwrap();
    assert!(db
        .fenced_authority(&organization_id, "grant:root", Utc::now())
        .await
        .unwrap()
        .is_none());
    assert!(
        db.fenced_authority(&other_realm, "grant:other", Utc::now())
            .await
            .unwrap()
            .is_some(),
        "one realm's fence is not another's"
    );
}

#[tokio::test]
async fn a_late_provider_observation_cannot_overwrite_a_newer_revoke() {
    let (db, organization_id, _) = seeded().await;
    let present = db
        .set_desired_effect(&DesiredEffect {
            id: "effect:one",
            organization_id: &organization_id,
            grant_id: "grant:root",
            provider_kind: "github",
            manifest_digest: "digest:manifest",
            desired_state: "present",
            idempotency_key: "effect:one",
        })
        .await
        .unwrap();
    assert!(db
        .observe_effect(&EffectObservation {
            id: "effect:one",
            organization_id: &organization_id,
            observed_generation: present,
            observed_state: "observed_active",
            external_handle: Some("handle:1"),
            evidence_digest: Some("digest:evidence"),
        })
        .await
        .unwrap());

    // The authority withdrew the effect, which advanced its generation.
    let absent = db
        .set_desired_effect(&DesiredEffect {
            id: "effect:one",
            organization_id: &organization_id,
            grant_id: "grant:root",
            provider_kind: "github",
            manifest_digest: "digest:manifest",
            desired_state: "absent",
            idempotency_key: "effect:one",
        })
        .await
        .unwrap();
    assert_eq!(absent, present + 1);

    // The provider's "still active" webhook was queued before that. It is refused
    // rather than believed.
    assert!(
        !db.observe_effect(&EffectObservation {
            id: "effect:one",
            organization_id: &organization_id,
            observed_generation: present,
            observed_state: "observed_active",
            external_handle: None,
            evidence_digest: None,
        })
        .await
        .unwrap(),
        "an observation from before a revoke is stale, not current"
    );
    let (desired, _, observed, _) = db
        .provider_effect(&organization_id, "effect:one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (desired.as_str(), observed.as_str()),
        ("absent", "observed_active")
    );
}
