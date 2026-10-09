//! AT-FGA-STALE: delayed `OpenFGA` projection cannot authorize dispatch.

use super::*;
use crate::app_state::test_demo_state;
use crate::routes::intents::ResolvedInvocation;
use chrono::{Duration, Utc};
use opensesame_domain::{
    ConnectionAuthorityBinding, ConnectionId, ConnectionRef, EgressBinding, Grant,
    GrantConstraints, GrantId, InvokeLevel, OfflineUse, OrganizationId, PrincipalId, ProjectId,
};
use opensesame_storage::authority::{
    AuthorityIssue, NewAccessDomain, PermissionEntry, ProjectionMark,
};

fn sample_grant(id: GrantId, org: OrganizationId, connection_id: ConnectionId) -> Grant {
    let now = Utc::now();
    Grant {
        id,
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: Some(ProjectId::new()),
        environment_id: None,
        connection_id: Some(connection_id),
        actions: vec!["repository.read".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 1,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

#[tokio::test]
async fn at_fga_stale_freshness_fence_denies_before_dispatch() {
    let state = test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let org_s = org.to_string();
    let grant_id = GrantId::new();
    let grant_s = grant_id.to_string();
    let connection_id = ConnectionId::new();
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, '{}', NULL, ?)",
    )
    .bind(&grant_s)
    .bind(&org_s)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db.pool())
    .await
    .unwrap();
    state
        .db
        .create_access_domain(&NewAccessDomain {
            id: "adom:fga-stale",
            organization_id: &org_s,
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap();
    let issue = AuthorityIssue {
        grant_id: &grant_s,
        organization_id: &org_s,
        domain_id: "adom:fga-stale",
        parent_grant_id: None,
        issuance_basis: "root",
        lineage_digest: "d",
        policy_digest: "d",
        role_revision: None,
        offer_id: None,
        delegation_depth_remaining: 1,
        not_before: Utc::now() - Duration::minutes(1),
        expires_at: Utc::now() + Duration::hours(1),
        evidence_id: None,
    };
    let entry = PermissionEntry {
        resource_selector: "repo:acme/catalog".into(),
        provider_operation_id: "repository.read".into(),
        action_set_json: "[\"repository.read\"]".into(),
        parameter_constraints_json: "{}".into(),
        audience_set_json: "[]".into(),
        manifest_digest: "d".into(),
    };
    assert!(state.db.issue_authority(&issue, &[entry]).await.unwrap());
    state
        .db
        .mark_projection_dirty(&ProjectionMark {
            store: "openfga",
            organization_id: &org_s,
            subject_kind: "grant",
            subject_id: &grant_s,
            committed_revision: 1,
        })
        .await
        .unwrap();
    let resolved = ResolvedInvocation {
        grant: sample_grant(grant_id, org, connection_id),
        lineage: None,
        delegation_chain: vec![],
        connection_id,
        principal_id: PrincipalId::new(),
        binding: ConnectionAuthorityBinding {
            connection_ref: ConnectionRef::new(org, None, "github", connection_id).unwrap(),
            internal_secret: None,
            credential_handle: None,
            egress: EgressBinding {
                scheme: "https".into(),
                authorities: vec!["api.github.com".into()],
                path_prefixes: vec![],
                allow_redirects_cross_authority: false,
            },
            max_invoke_level: InvokeLevel::TypedOperation,
        },
        connection_policy_id: "github".into(),
        spend_budget: None,
        broker_connection: true,
    };
    let err = authorize_openfga(
        &state,
        &org_s,
        "user:alice",
        &resolved,
        "repository.read",
        "repo:acme/catalog",
    )
    .await
    .expect_err("stale projection must deny");
    assert_eq!(err.status(), StatusCode::FORBIDDEN);
}
