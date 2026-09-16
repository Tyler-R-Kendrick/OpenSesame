//! Named AT-* adversarial acceptance regressions backed by storage fences.
//!
//! Thin wrappers over existing authority behavior so the adversarial matrix can
//! name a test ID → file::test → cargo command without Discord/Blocky SaaS.

mod authority_support;

use chrono::Utc;
use opensesame_storage::authority::{DomainReparent, NewAccessDomain};
use opensesame_storage::Db;

use authority_support::{entry, issue, seed_grant, seed_realm};

/// AT-REALM-ID — a domain cannot take a parent from another realm.
#[tokio::test]
async fn at_realm_id_cross_realm_domain_parent_refused() {
    let db = Db::connect_memory().await.unwrap();
    seed_realm(&db, "org:one").await;
    seed_realm(&db, "org:two").await;
    db.create_access_domain(&NewAccessDomain {
        id: "dom:one",
        organization_id: "org:one",
        parent_id: None,
        project_id: None,
    })
    .await
    .unwrap();

    let crossed = db
        .create_access_domain(&NewAccessDomain {
            id: "dom:crossed",
            organization_id: "org:two",
            parent_id: Some("dom:one"),
            project_id: None,
        })
        .await
        .unwrap();
    assert!(!crossed);
}

/// AT-COHORT-CYCLE (domain forest) — concurrent A→B / B→A cannot form a cycle.
#[tokio::test]
async fn at_cohort_cycle_domain_reparent_refused() {
    let db = Db::connect_memory().await.unwrap();
    seed_realm(&db, "org:one").await;
    for id in ["dom:a", "dom:b"] {
        db.create_access_domain(&NewAccessDomain {
            id,
            organization_id: "org:one",
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap();
    }
    assert!(db
        .reparent_access_domain(&DomainReparent {
            organization_id: "org:one",
            id: "dom:a",
            expected_revision: 1,
            new_parent_id: Some("dom:b"),
        })
        .await
        .unwrap());
    let cycle = db
        .reparent_access_domain(&DomainReparent {
            organization_id: "org:one",
            id: "dom:b",
            expected_revision: 1,
            new_parent_id: Some("dom:a"),
        })
        .await
        .unwrap();
    assert!(!cycle, "closing the cycle must be refused");
}

/// AT-STATE-RESTORE — recovery generation fences pre-restore authority.
#[tokio::test]
async fn at_state_restore_generation_fence() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:root").await;
    assert!(db
        .issue_authority(
            &issue("grant:root", &organization_id, &domain_id),
            &[entry("resource:A", "read")],
        )
        .await
        .unwrap());
    assert!(db
        .fenced_authority(&organization_id, "grant:root", Utc::now())
        .await
        .unwrap()
        .is_some());

    let generation = db
        .advance_recovery_generation("AT-STATE-RESTORE fixture restore")
        .await
        .unwrap();
    assert!(generation >= 2);
    assert!(
        db.fenced_authority(&organization_id, "grant:root", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "authority issued before restore must not survive the generation fence"
    );
}

/// AT-MULTIWRITER — only one writer holds the lease; the other is refused.
#[tokio::test]
async fn at_multiwriter_lease_fence() {
    let db = Db::connect_memory().await.unwrap();
    let first = db
        .acquire_writer_lease("writer:one", 60)
        .await
        .unwrap()
        .expect("first writer takes the lease");
    assert!(db
        .acquire_writer_lease("writer:two", 60)
        .await
        .unwrap()
        .is_none());
    db.assert_writer_lease(&first).await.unwrap();
}

/// AT-BUDGET-FANOUT — concurrent reserves cannot exceed the window cap.
#[tokio::test]
async fn at_budget_fanout_cannot_exceed_cap() {
    use opensesame_storage::authority::{BudgetScope, Reservation, ReserveOutcome};
    use std::sync::Arc;

    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:one").await;
    seed_grant(&db, &organization_id, "grant:root").await;
    db.issue_authority(
        &issue("grant:root", &organization_id, &domain_id),
        &[entry("resource:A", "read")],
    )
    .await
    .unwrap();

    let scope = BudgetScope {
        organization_id: organization_id.as_str(),
        scope_kind: "root_grant",
        scope_id: "grant:root",
        unit: "api_calls",
        window_key: "2026-09-15",
    };
    db.set_authority_budget(&scope, 5).await.unwrap();

    let db = Arc::new(db);
    let mut handles = Vec::new();
    for index in 0..50 {
        let db = Arc::clone(&db);
        let organization_id = organization_id.clone();
        handles.push(tokio::spawn(async move {
            db.reserve_authority_budget(&Reservation {
                scope: BudgetScope {
                    organization_id: organization_id.as_str(),
                    scope_kind: "root_grant",
                    scope_id: "grant:root",
                    unit: "api_calls",
                    window_key: "2026-09-15",
                },
                grant_id: "grant:root",
                quantity: 1,
                idempotency_key: &format!("at-fanout:{index}"),
            })
            .await
            .unwrap()
        }));
    }
    let mut accepted = 0;
    for handle in handles {
        if matches!(handle.await.unwrap(), ReserveOutcome::Accepted { .. }) {
            accepted += 1;
        }
    }
    assert_eq!(accepted, 5);
}
