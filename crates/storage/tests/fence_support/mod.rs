//! Shared fixtures for the invalidation-fence suites (ADR 0121).
//!
//! A directory module rather than a top-level `tests/*.rs` file, so Cargo
//! does not compile it as a test binary of its own. Split out so each suite
//! stays inside the 400-line module budget (ADR 0093).
#![allow(dead_code)]

use chrono::{DateTime, Duration, Utc};
use opensesame_domain::{
    ConnectionId, Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId,
};
use opensesame_lifecycle::{FenceVerdict, Freshness};
use opensesame_storage::Db;

pub async fn db() -> Db {
    Db::connect_sqlite("sqlite::memory:")
        .await
        .expect("migrations apply")
}

/// `grants.organization_id` is a real foreign key, so the realm has to exist
/// before any grant can hang off it.
pub async fn seed_organization(db: &Db, organization_id: OrganizationId) {
    sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
        .bind(organization_id.to_string())
        .bind("fence tests")
        .bind(Utc::now().to_rfc3339())
        .execute(db.pool())
        .await
        .expect("organization inserts");
}

/// A root grant wide enough that children can attenuate under it.
pub fn root_grant(organization_id: OrganizationId, now: DateTime<Utc>) -> Grant {
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id,
        project_id: None,
        environment_id: None,
        connection_id: Some(ConnectionId::new()),
        actions: vec!["repository.read".into()],
        resources: vec!["*".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(4),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 8,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

/// A child that narrows nothing but its position in the chain — enough for the
/// fence, which is blind to authority shape.
pub fn child_of(parent: &Grant, now: DateTime<Utc>) -> Grant {
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(1);
    child.created_at = now;
    child
}

/// Persist a root and `depth` descendants below it, returning the whole chain.
pub async fn seed_chain(db: &Db, depth: usize) -> Vec<Grant> {
    let now = Utc::now();
    let organization_id = OrganizationId::new();
    seed_organization(db, organization_id).await;
    let mut chain = vec![root_grant(organization_id, now)];
    db.insert_grant(&chain[0]).await.expect("root inserts");
    for _ in 0..depth {
        let parent = chain.last().expect("a parent").clone();
        let child = child_of(&parent, now);
        db.insert_grant(&child).await.expect("child inserts");
        chain.push(child);
    }
    chain
}

pub async fn status(db: &Db, grant: &Grant) -> FenceVerdict {
    db.fence_status(&grant.id.to_string(), Freshness::any())
        .await
}
