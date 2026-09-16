//! FIX-FAMILY — household scheduled access, budgets, and expiry (storage path).
//!
//! Domain-side snapshot exclusion and guardian/vault separation live in
//! `opensesame-domain::fix_family`. This module exercises the durable grant,
//! budget ledger, and fenced read that a household schedule actually hits.

use std::sync::Arc;

use chrono::{Duration, Utc};

use super::fix_support::{budget_scope, entry, issue, seed_grant, seed_realm};
use super::{Reservation, ReserveOutcome};
use crate::Db;

#[tokio::test]
async fn fix_family_scheduled_window_denies_before_not_before() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:family").await;
    seed_grant(&db, &organization_id, "grant:kid").await;

    let mut scheduled = issue("grant:kid", &organization_id, &domain_id);
    scheduled.not_before = Utc::now() + Duration::hours(2);
    scheduled.expires_at = Utc::now() + Duration::hours(4);
    assert!(db
        .issue_authority(&scheduled, &[entry("device:tablet", "browse")])
        .await
        .unwrap());

    assert!(
        db.fenced_authority(&organization_id, "grant:kid", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "a scheduled window must deny before not_before"
    );

    let inside = Utc::now() + Duration::hours(3);
    assert!(
        db.fenced_authority(&organization_id, "grant:kid", inside)
            .await
            .unwrap()
            .is_some(),
        "the same grant must pass once the window opens"
    );
}

#[tokio::test]
async fn fix_family_bounded_budget_refuses_overspend() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:family").await;
    seed_grant(&db, &organization_id, "grant:kid").await;
    assert!(db
        .issue_authority(
            &issue("grant:kid", &organization_id, &domain_id),
            &[entry("device:tablet", "browse")],
        )
        .await
        .unwrap());

    let scope = budget_scope(&organization_id, "grant:kid", "2026-09-15");
    db.set_authority_budget(&scope, 3).await.unwrap();

    let db = Arc::new(db);
    let mut accepted = 0;
    let mut handles = Vec::new();
    for index in 0..20 {
        let db = Arc::clone(&db);
        handles.push(tokio::spawn(async move {
            db.reserve_authority_budget(&Reservation {
                scope: budget_scope("org:family", "grant:kid", "2026-09-15"),
                grant_id: "grant:kid",
                quantity: 1,
                idempotency_key: &format!("browse:{index}"),
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
    assert_eq!(accepted, 3, "a household budget must conserve under concurrent spend");
}

#[tokio::test]
async fn fix_family_expiry_denies_the_next_activation() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:family").await;
    seed_grant(&db, &organization_id, "grant:kid").await;

    let opened = Utc::now() - Duration::minutes(10);
    let closes = Utc::now() + Duration::minutes(5);
    let mut windowed = issue("grant:kid", &organization_id, &domain_id);
    windowed.not_before = opened;
    windowed.expires_at = closes;
    assert!(db
        .issue_authority(&windowed, &[entry("device:tablet", "browse")])
        .await
        .unwrap());
    assert!(
        db.fenced_authority(&organization_id, "grant:kid", Utc::now())
            .await
            .unwrap()
            .is_some(),
        "inside the window the grant must activate"
    );

    let after = closes + Duration::seconds(1);
    assert!(
        db.fenced_authority(&organization_id, "grant:kid", after)
            .await
            .unwrap()
            .is_none(),
        "expiry must deny the next activation after expires_at"
    );
}
