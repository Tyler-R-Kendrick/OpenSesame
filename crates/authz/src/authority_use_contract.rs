//! Contract tests for custodian-style authority use.
//!
//! Moved out of `authority_use.rs` so the module itself stays within the
//! structural budget; the contracts are unchanged.

use crate::{
    assert_no_secret_in_agent_payload, authorize_authority_use, github_binding, AuthorityUse,
    AuthzError, PolicyEngine,
};
use chrono::{Duration, Utc};
use opensesame_domain::{
    AuthorityOperation, ConnectionAuthorityBinding, ConnectionId, ConnectionRef, Grant,
    GrantConstraints, GrantId, InvokeLevel, OfflineUse, OrganizationId, PrincipalId,
};

fn grant(export: bool) -> Grant {
    let now = Utc::now();
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: OrganizationId::new(),
        project_id: None,
        environment_id: None,
        connection_id: None,
        actions: vec!["pull_request.create".into(), "repository.read".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: export,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

fn engine() -> PolicyEngine {
    let mut e = PolicyEngine::default();
    e.relationships
        .write("connection:demo-conn", "user", "user:demo");
    e.assurance.insert("user:demo".into(), "mfa".into());
    e
}

fn binding() -> ConnectionAuthorityBinding {
    let org = OrganizationId::new();
    let cref = ConnectionRef::new(org, None, "github/main", ConnectionId::new()).unwrap();
    github_binding(cref, "github/legacy-token")
}

#[test]
fn connection_ref_knowledge_does_not_export() {
    let b = binding();
    assert!(b.resolve_secret_for_agent().is_err());
    let agent_json = serde_json::to_value(b.agent_view()).unwrap();
    assert_no_secret_in_agent_payload(&agent_json).unwrap();
    assert!(!agent_json.to_string().contains("secret://"));
}

#[test]
fn level3_denied_without_export_grant() {
    let e = engine();
    let g = grant(false);
    let b = binding();
    let err = authorize_authority_use(
        &e,
        &AuthorityUse {
            subject: "user:demo",
            grant: &g,
            binding: &b,
            op: AuthorityOperation::Resolve,
            level: InvokeLevel::Materialize,
            requested_url: None,
            requested_action: None,
            connection_policy_id: "demo-conn",
            lineage: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AuthzError::Denied(_)));
}

#[test]
fn level2_evil_url_denied_even_with_connection() {
    let e = engine();
    let g = grant(false);
    let b = binding();
    let err = authorize_authority_use(
        &e,
        &AuthorityUse {
            subject: "user:demo",
            grant: &g,
            binding: &b,
            op: AuthorityOperation::Invoke,
            level: InvokeLevel::ConstrainedHttp,
            requested_url: Some("https://evil.example/exfil"),
            requested_action: Some("pull_request.create"),
            connection_policy_id: "demo-conn",
            lineage: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AuthzError::Denied(_)));
}

#[test]
fn level2_github_url_allowed_when_granted() {
    let e = engine();
    let g = grant(false);
    let b = binding();
    let d = authorize_authority_use(
        &e,
        &AuthorityUse {
            subject: "user:demo",
            grant: &g,
            binding: &b,
            op: AuthorityOperation::Invoke,
            level: InvokeLevel::ConstrainedHttp,
            requested_url: Some("https://api.github.com/repos/acme/catalog/pulls"),
            requested_action: Some("pull_request.create"),
            connection_policy_id: "demo-conn",
            lineage: None,
        },
    )
    .unwrap();
    assert!(d.allowed);
}

#[test]
fn an_action_the_grant_does_not_list_is_denied() {
    let e = engine();
    let g = grant(false);
    let b = binding();
    let url = Some("https://api.github.com/repos/acme/catalog/pulls");
    // The grant lists pull_request.create and repository.read, not this.
    let err = authorize_authority_use(
        &e,
        &AuthorityUse {
            subject: "user:demo",
            grant: &g,
            binding: &b,
            op: AuthorityOperation::Invoke,
            level: InvokeLevel::ConstrainedHttp,
            requested_url: url,
            requested_action: Some("repository.delete"),
            connection_policy_id: "demo-conn",
            lineage: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AuthzError::Denied(m) if m.contains("repository.delete")));

    // A use that names no action cannot be checked against the grant's list.
    let err = authorize_authority_use(
        &e,
        &AuthorityUse {
            subject: "user:demo",
            grant: &g,
            binding: &b,
            op: AuthorityOperation::Invoke,
            level: InvokeLevel::ConstrainedHttp,
            requested_url: url,
            requested_action: None,
            connection_policy_id: "demo-conn",
            lineage: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AuthzError::Denied(m) if m.contains("must name the action")));

    // Every action the grant does list is usable, not just the first.
    for action in ["pull_request.create", "repository.read"] {
        let d = authorize_authority_use(
            &e,
            &AuthorityUse {
                subject: "user:demo",
                grant: &g,
                binding: &b,
                op: AuthorityOperation::Invoke,
                level: InvokeLevel::ConstrainedHttp,
                requested_url: url,
                requested_action: Some(action),
                connection_policy_id: "demo-conn",
                lineage: None,
            },
        )
        .unwrap();
        assert!(d.allowed, "{action}");
    }
}

#[test]
fn redirect_cross_authority_denied() {
    let b = binding();
    assert!(b
        .egress
        .allows_redirect("https://api.github.com/repos/x", "https://evil.example/x")
        .is_err());
}
