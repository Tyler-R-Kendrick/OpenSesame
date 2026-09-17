//! GA-V-33b — AuthorityGrant expiry reaches the lifecycle feed via gateway scan.
//!
//! Issues a generalized authority sidecar with a past `expires_at`, runs
//! `scan_organization`, and asserts the expired watermark was claimed. This is
//! the running-gateway half of INV-GA-05 (unit half is GA-V-33).

use chrono::{Duration, Utc};
use opensesame_lifecycle::{ExpiryStage, SubjectKind, EVENT_EXPIRY_EXPIRED};
use opensesame_storage::authority::{AuthorityIssue, NewAccessDomain, PermissionEntry};
use serde_json::json;

use crate::app_state::test_demo_state;
use crate::lifecycle::scanner::scan_organization;

async fn seed_grant(db: &opensesame_storage::Db, organization_id: &str, grant_id: &str) {
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(grant_id)
    .bind(organization_id)
    .bind(
        json!({
            "id": grant_id,
            "actions": ["read"],
            "resources": ["connection:alpha"],
            "connection_id": "connection:alpha",
            "parent_grant_id": serde_json::Value::Null,
            "delegation_depth": 0,
            "created_at": (Utc::now() - Duration::hours(2)).to_rfc3339(),
            "expires_at": (Utc::now() - Duration::minutes(5)).to_rfc3339(),
        })
        .to_string(),
    )
    .bind(Utc::now().to_rfc3339())
    .execute(db.pool())
    .await
    .expect("seed grant envelope");
}

#[tokio::test]
async fn authority_grant_expiry_reaches_lifecycle_feed_via_scan() {
    let state = test_demo_state().await;
    let org = state.connection_organization;
    let org_s = org.to_string();

    state
        .db
        .create_access_domain(&NewAccessDomain {
            id: "adom:expiry",
            organization_id: &org_s,
            parent_id: None,
            project_id: None,
        })
        .await
        .expect("domain");

    seed_grant(&state.db, &org_s, "grant:expired").await;
    let expires_at = Utc::now() - Duration::minutes(5);
    assert!(state
        .db
        .issue_authority(
            &AuthorityIssue {
                grant_id: "grant:expired",
                organization_id: &org_s,
                domain_id: "adom:expiry",
                parent_grant_id: None,
                issuance_basis: "root",
                lineage_digest: "digest:lineage",
                policy_digest: "digest:policy",
                role_revision: None,
                offer_id: None,
                delegation_depth_remaining: 0,
                not_before: expires_at - Duration::hours(1),
                expires_at,
                evidence_id: None,
            },
            &[PermissionEntry {
                resource_selector: "resource:A".into(),
                provider_operation_id: "connection.invoke:connection:alpha".into(),
                action_set_json: "[\"read\"]".into(),
                parameter_constraints_json: "{}".into(),
                audience_set_json: "[]".into(),
                manifest_digest: "digest:manifest".into(),
            }],
        )
        .await
        .expect("issue"));

    let now = Utc::now();
    let fired = scan_organization(&state, &org, now).await.expect("scan");
    assert!(fired > 0, "expired authority grant must fire at least once");

    let marks = state
        .db
        .list_lifecycle_watermarks(&org_s)
        .await
        .expect("watermarks");
    let expired = marks.iter().find(|row| {
        row.subject_kind == SubjectKind::AuthorityGrant.as_str()
            && row.subject_id == "grant:expired"
            && row.stage == ExpiryStage::Expired.as_str()
    });
    assert!(
        expired.is_some(),
        "expected {EVENT_EXPIRY_EXPIRED} watermark for grant:expired, got {marks:?}"
    );
}
