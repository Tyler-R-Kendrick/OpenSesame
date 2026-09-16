//! FIX-WORKCELL — budget conservation under concurrent spend (storage path).
//!
//! Omitted-child budget refusal and spawn-depth refusal live in
//! `opensesame-domain::fix_workcell`. This module hits the atomic ledger.

use std::sync::Arc;

use super::fix_support::{budget_scope, entry, issue, seed_grant, seed_realm};
use super::{Reservation, ReserveOutcome};
use crate::Db;

#[tokio::test]
async fn fix_workcell_budget_conservation_under_concurrent_spend() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed_realm(&db, "org:workcell").await;
    seed_grant(&db, &organization_id, "grant:task").await;
    assert!(db
        .issue_authority(
            &issue("grant:task", &organization_id, &domain_id),
            &[entry("fixture:api", "invoke")],
        )
        .await
        .unwrap());

    // Frozen envelope: 100 shared fixture API operations.
    let scope = budget_scope(&organization_id, "grant:task", "workcell:run");
    db.set_authority_budget(&scope, 100).await.unwrap();

    let db = Arc::new(db);
    let mut accepted = 0;
    let mut handles = Vec::new();
    // More concurrent spend attempts than remaining capacity.
    for index in 0..250 {
        let db = Arc::clone(&db);
        handles.push(tokio::spawn(async move {
            db.reserve_authority_budget(&Reservation {
                scope: budget_scope("org:workcell", "grant:task", "workcell:run"),
                grant_id: "grant:task",
                quantity: 1,
                idempotency_key: &format!("op:{index}"),
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
    assert_eq!(
        accepted, 100,
        "concurrent spend must settle at most the authorized total"
    );
}
