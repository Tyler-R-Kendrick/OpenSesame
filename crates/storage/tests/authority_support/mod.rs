//! Fixtures for the generalized-authority suites.
//!
//! Realms and `grants` rows are written here with raw SQL on purpose. These
//! suites need readable ids and *legacy-shaped* grant bodies — including
//! malformed, expired and revoked ones — which is exactly what the public
//! constructors refuse to build. Everything the suites then exercise goes through
//! the public `Db` API.
#![allow(dead_code)]

use chrono::{DateTime, Duration, Utc};
use opensesame_storage::authority::{AuthorityIssue, NewAccessDomain, PermissionEntry};
use opensesame_storage::Db;

/// Create a realm with one active root domain, returning both ids.
pub async fn seed_realm(db: &Db, organization_id: &str) -> (String, String) {
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

/// Seed a live legacy `grants` row that generalized authority can be recorded
/// against.
pub async fn seed_grant(db: &Db, organization_id: &str, grant_id: &str) {
    seed_grant_body(
        db,
        organization_id,
        grant_id,
        &legacy_body(grant_id, Utc::now() + Duration::hours(24)),
        None,
    )
    .await;
}

/// Seed a `grants` row with an exact body and revocation state.
pub async fn seed_grant_body(
    db: &Db,
    organization_id: &str,
    grant_id: &str,
    body_json: &str,
    revoked_at: Option<DateTime<Utc>>,
) {
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(grant_id)
    .bind(organization_id)
    .bind(body_json)
    .bind(revoked_at.map(|at| at.to_rfc3339()))
    .bind(Utc::now().to_rfc3339())
    .execute(db.pool())
    .await
    .expect("legacy grant row");
}

/// A legacy grant body: a flat action list, a flat resource list, a connection,
/// and an expiry.
pub fn legacy_body(grant_id: &str, expires_at: DateTime<Utc>) -> String {
    serde_json::json!({
        "id": grant_id,
        "actions": ["read", "write"],
        "resources": ["connection:alpha"],
        "connection_id": "connection:alpha",
        "parent_grant_id": serde_json::Value::Null,
        "delegation_depth": 0,
        "created_at": (Utc::now() - Duration::hours(1)).to_rfc3339(),
        "constraints": {
            "not_before": (Utc::now() - Duration::hours(1)).to_rfc3339(),
            "expires_at": expires_at.to_rfc3339(),
        },
    })
    .to_string()
}

/// A root issuance for one grant, valid for an hour.
pub fn issue<'a>(
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

/// One correlated entry.
pub fn entry(resource_selector: &str, action: &str) -> PermissionEntry {
    PermissionEntry {
        resource_selector: resource_selector.to_owned(),
        provider_operation_id: "connection.invoke:connection:alpha".to_owned(),
        action_set_json: serde_json::json!([action]).to_string(),
        parameter_constraints_json: "{\"method\":[\"GET\"]}".to_owned(),
        audience_set_json: "[\"https://provider.example\"]".to_owned(),
        manifest_digest: "digest:manifest".to_owned(),
    }
}
