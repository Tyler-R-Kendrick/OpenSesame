//! AUD-EVENTS — authority mutations leave durable outbox intent.

use chrono::{Duration, Utc};

use super::{AuthorityIssue, NewAccessDomain, PermissionEntry};
use crate::Db;

async fn seed(db: &Db) -> (String, String) {
    let organization_id = "org:outbox".to_owned();
    sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
        .bind(&organization_id)
        .bind("outbox")
        .bind(Utc::now().to_rfc3339())
        .execute(db.pool())
        .await
        .unwrap();
    let domain_id = "dom:outbox".to_owned();
    assert!(db
        .create_access_domain(&NewAccessDomain {
            id: &domain_id,
            organization_id: &organization_id,
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap());
    (organization_id, domain_id)
}

#[tokio::test]
async fn issuing_authority_writes_an_outbox_event() {
    let db = Db::connect_memory().await.unwrap();
    let (organization_id, domain_id) = seed(&db).await;
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, '{}', NULL, ?)",
    )
    .bind("grant:outbox")
    .bind(&organization_id)
    .bind(Utc::now().to_rfc3339())
    .execute(db.pool())
    .await
    .unwrap();

    assert!(db
        .issue_authority(
            &AuthorityIssue {
                grant_id: "grant:outbox",
                organization_id: &organization_id,
                domain_id: &domain_id,
                parent_grant_id: None,
                issuance_basis: "root",
                lineage_digest: "digest:lineage",
                policy_digest: "digest:policy",
                role_revision: None,
                offer_id: None,
                delegation_depth_remaining: 0,
                not_before: Utc::now() - Duration::minutes(1),
                expires_at: Utc::now() + Duration::hours(1),
                evidence_id: None,
            },
            &[PermissionEntry {
                resource_selector: "resource:a".into(),
                provider_operation_id: "op:read".into(),
                action_set_json: "[\"read\"]".into(),
                parameter_constraints_json: "{}".into(),
                audience_set_json: "[]".into(),
                manifest_digest: "digest:manifest".into(),
            }],
        )
        .await
        .unwrap());

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE event_type = 'authority.grant.issued'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert!(
        count >= 1,
        "issue_authority must leave durable outbox intent with the grant"
    );
}
