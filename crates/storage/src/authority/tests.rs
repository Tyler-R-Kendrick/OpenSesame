//! Race contracts the authority fabric names by exact path (GA-V-25..27).
//!
//! These live under `--lib` so `pnpm test:authority-fabric` can settle them;
//! the longer integration suites under `crates/storage/tests/authority_*`
//! remain the place for broader coverage of the same surfaces.

use std::sync::Arc;

use chrono::{Duration, Utc};

use super::{
    AuthorityIssue, BudgetScope, DomainReparent, NewAccessDomain, PermissionEntry, Reservation,
    ReserveOutcome,
};
use crate::Db;

async fn seed_realm(db: &Db, organization_id: &str) -> (String, String) {
    sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
        .bind(organization_id)
        .bind(organization_id)
        .bind(Utc::now().to_rfc3339())
        .execute(db.pool())
        .await
        .expect("realm row");
    let domain_id = format!("dom:{organization_id}");
    db.create_access_domain(&NewAccessDomain {
        id: &domain_id,
        organization_id,
        parent_id: None,
        project_id: None,
    })
    .await
    .expect("domain");
    (organization_id.to_owned(), domain_id)
}

async fn seed_grant(db: &Db, organization_id: &str, grant_id: &str) {
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(grant_id)
    .bind(organization_id)
    .bind(
        serde_json::json!({
            "id": grant_id,
            "actions": ["read"],
            "resources": ["connection:alpha"],
            "connection_id": "connection:alpha",
            "parent_grant_id": serde_json::Value::Null,
            "delegation_depth": 0,
            "created_at": (Utc::now() - Duration::hours(1)).to_rfc3339(),
            "expires_at": (Utc::now() + Duration::hours(24)).to_rfc3339(),
        })
        .to_string(),
    )
    .bind(Utc::now().to_rfc3339())
    .execute(db.pool())
    .await
    .expect("legacy grant row");
}

fn issue<'a>(
    grant_id: &'a str,
    organization_id: &'a str,
    domain_id: &'a str,
) -> AuthorityIssue<'a> {
    AuthorityIssue {
        grant_id,
        organization_id,
        domain_id,
        parent_grant_id: None,
        issuance_basis: "root",
        lineage_digest: "digest:lineage",
        policy_digest: "digest:policy",
        role_revision: None,
        offer_id: None,
        delegation_depth_remaining: 1,
        not_before: Utc::now() - Duration::minutes(1),
        expires_at: Utc::now() + Duration::hours(1),
        evidence_id: None,
    }
}

fn entry(resource_selector: &str, action: &str) -> PermissionEntry {
    PermissionEntry {
        resource_selector: resource_selector.to_owned(),
        provider_operation_id: "connection.invoke:connection:alpha".to_owned(),
        action_set_json: serde_json::json!([action]).to_string(),
        parameter_constraints_json: "{\"method\":[\"GET\"]}".to_owned(),
        audience_set_json: "[\"https://provider.example\"]".to_owned(),
        manifest_digest: "digest:manifest".to_owned(),
    }
}

fn budget_scope<'a>(organization_id: &'a str) -> BudgetScope<'a> {
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
async fn a_revoked_ancestor_denies_a_descendant_on_the_next_read() {
    let (db, organization_id, domain_id) = seeded().await;
    seed_grant(&db, &organization_id, "grant:child").await;
    let mut child = issue("grant:child", &organization_id, &domain_id);
    child.parent_grant_id = Some("grant:root");
    child.issuance_basis = "delegation";
    child.delegation_depth_remaining = 0;
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

    assert!(
        db.fenced_authority(&organization_id, "grant:child", Utc::now())
            .await
            .unwrap()
            .is_none(),
        "a revoked ancestor makes every derived authority unusable on the next read"
    );
}

#[tokio::test]
async fn concurrent_debits_cannot_exceed_a_window_cap() {
    let (db, organization_id, _) = seeded().await;
    db.set_authority_budget(&budget_scope(&organization_id), 10)
        .await
        .unwrap();

    let db = Arc::new(db);
    let mut accepted = 0;
    let mut handles = Vec::new();
    for index in 0..100 {
        let db = Arc::clone(&db);
        handles.push(tokio::spawn(async move {
            db.reserve_authority_budget(&Reservation {
                scope: budget_scope("org:one"),
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
    assert_eq!(accepted, 10, "concurrent debits cannot double-spend a window cap");
}

#[tokio::test]
async fn interleaved_chain_writes_cannot_create_a_cycle() {
    let db = Db::connect_memory().await.unwrap();
    seed_realm(&db, "org:one").await;
    for (id, parent) in [("dom:a", None), ("dom:b", None)] {
        db.create_access_domain(&NewAccessDomain {
            id,
            organization_id: "org:one",
            parent_id: parent,
            project_id: None,
        })
        .await
        .unwrap();
    }

    let db = Arc::new(db);
    let left = {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            db.reparent_access_domain(&DomainReparent {
                organization_id: "org:one",
                id: "dom:a",
                expected_revision: 1,
                new_parent_id: Some("dom:b"),
            })
            .await
            .unwrap()
        })
    };
    let right = {
        let db = Arc::clone(&db);
        tokio::spawn(async move {
            db.reparent_access_domain(&DomainReparent {
                organization_id: "org:one",
                id: "dom:b",
                expected_revision: 1,
                new_parent_id: Some("dom:a"),
            })
            .await
            .unwrap()
        })
    };

    let accepted = usize::from(left.await.unwrap()) + usize::from(right.await.unwrap());
    assert!(
        accepted <= 1,
        "two concurrent chain writes cannot combine into a cycle; accepted {accepted}"
    );

    let a = db.access_domain("org:one", "dom:a").await.unwrap().unwrap();
    let b = db.access_domain("org:one", "dom:b").await.unwrap().unwrap();
    let a_under_b = a.parent_id.as_deref() == Some("dom:b");
    let b_under_a = b.parent_id.as_deref() == Some("dom:a");
    assert!(
        !(a_under_b && b_under_a),
        "stored parents must not form a cycle"
    );
}
