//! Shared fixtures for FIX-* authority scenario suites (cfg(test) only).
//!
//! Kept small and local so the fabric scenarios under `--lib` do not depend on
//! the integration-test helper crate at `crates/storage/tests/authority_support`.

use chrono::{Duration, Utc};

use super::{AuthorityIssue, BudgetScope, NewAccessDomain, PermissionEntry};
use crate::Db;

pub(super) async fn seed_realm(db: &Db, organization_id: &str) -> (String, String) {
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

pub(super) async fn seed_grant(db: &Db, organization_id: &str, grant_id: &str) {
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

pub(super) fn issue<'a>(
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

pub(super) fn entry(resource_selector: &str, action: &str) -> PermissionEntry {
    PermissionEntry {
        resource_selector: resource_selector.to_owned(),
        provider_operation_id: format!("op:{action}"),
        action_set_json: serde_json::json!([action]).to_string(),
        parameter_constraints_json: "{}".to_owned(),
        audience_set_json: "[]".to_owned(),
        manifest_digest: "digest:manifest".to_owned(),
    }
}

pub(super) fn budget_scope<'a>(
    organization_id: &'a str,
    scope_id: &'a str,
    window_key: &'a str,
) -> BudgetScope<'a> {
    BudgetScope {
        organization_id,
        scope_kind: "root_grant",
        scope_id,
        unit: "api_calls",
        window_key,
    }
}
