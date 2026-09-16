//! Contract tests for the AuthZEN-shaped `PolicyEngine::decide` facade.
//!
//! These live beside the engine rather than inside it so the module itself stays
//! within the structural budget; they are the same contracts, unchanged.

use crate::{
    AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, AuthzError, PolicyEngine,
};
use chrono::{DateTime, Duration, Utc};
use opensesame_domain::{
    AvailabilityClass, ConnectionId, Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId,
    PrincipalId, ValidatedGrantChain,
};
use serde_json::json;

fn engine_two_orgs() -> PolicyEngine {
    let mut e = PolicyEngine::default();
    e.relationships
        .write("organization:orgA", "member", "user:alice");
    e.relationships
        .write("organization:orgB", "member", "user:bob");
    e.relationships
        .write("project:projA", "developer", "user:alice");
    e.relationships
        .write("project:projB", "developer", "user:bob");
    e.relationships
        .write("connection:connA", "user", "user:alice");
    e.assurance.insert("user:alice".into(), "mfa".into());
    e
}

#[test]
fn tenant_isolation() {
    let e = engine_two_orgs();
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:alice".into(),
            properties: json!({}),
        },
        action: AuthZenAction {
            name: "read".into(),
        },
        resource: AuthZenResource {
            type_: "project".into(),
            id: "projB".into(),
        },
        context: json!({}),
    };
    let d = e
        .decide(&req, None, None, AvailabilityClass::A2AuthorityRequired)
        .unwrap();
    assert!(!d.decision);
}

#[test]
fn a_relationship_alone_still_authorizes_a_read_with_no_grant() {
    // The layers a read does not need report "nothing to say", and one permit
    // with no refusal is still a permit — the closed-world rule denies when
    // *nothing* applied, not when a grant was not required.
    let e = engine_two_orgs();
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:alice".into(),
            properties: json!({}),
        },
        action: AuthZenAction {
            name: "read".into(),
        },
        resource: AuthZenResource {
            type_: "project".into(),
            id: "projA".into(),
        },
        context: json!({}),
    };
    let d = e
        .decide(&req, None, None, AvailabilityClass::A2AuthorityRequired)
        .unwrap();
    assert!(d.decision);
    assert_eq!(d.obligations.len(), 1, "a permit still owes a receipt");
}

#[test]
fn export_denied_by_default() {
    let e = engine_two_orgs();
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:alice".into(),
            properties: json!({}),
        },
        action: AuthZenAction {
            name: "credential.export".into(),
        },
        resource: AuthZenResource {
            type_: "connection".into(),
            id: "connA".into(),
        },
        context: json!({}),
    };
    let d = e
        .decide(&req, None, None, AvailabilityClass::A2AuthorityRequired)
        .unwrap();
    assert!(!d.decision);
}

#[test]
fn fail_closed_without_quorum() {
    let mut e = engine_two_orgs();
    e.authority_quorum = false;
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:alice".into(),
            properties: json!({}),
        },
        action: AuthZenAction {
            name: "grant.create".into(),
        },
        resource: AuthZenResource {
            type_: "project".into(),
            id: "projA".into(),
        },
        context: json!({}),
    };
    assert_eq!(
        e.decide(&req, None, None, AvailabilityClass::A2AuthorityRequired)
            .unwrap_err(),
        AuthzError::AuthorityUnavailable
    );
}

fn root_grant(now: DateTime<Utc>, connection: ConnectionId, org: OrganizationId) -> Grant {
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: None,
        environment_id: None,
        connection_id: Some(connection),
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
            budgets: [("calls".into(), 10)].into_iter().collect(),
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

#[test]
fn contract_a_delegated_grant_is_eligibility_for_its_own_connection_only() {
    // No tuple exists for the delegate: eligibility must come from a
    // ValidatedGrantChain, and only for the connection the leaf names.
    // A raw parent_grant_id pointer alone must never authorize (AT-RAW-PARENT).
    let e = engine_two_orgs();
    let now = Utc::now();
    let connection = ConnectionId::new();
    let org = OrganizationId::new();
    let root = root_grant(now, connection, org);
    let mut child = root.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(root.id);
    child.delegation_depth = 1;
    child.constraints.maximum_delegation_depth = 0;
    child.constraints.budgets.insert("calls".into(), 5);
    child.constraints.expires_at = root.constraints.expires_at - Duration::minutes(1);
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:guest".into(),
            properties: json!({}),
        },
        action: AuthZenAction {
            name: "repository.read".into(),
        },
        resource: AuthZenResource {
            type_: "connector_operation".into(),
            id: "repo:acme/catalog".into(),
        },
        context: json!({
            "connection_id": "connA",
            "connection_uuid": connection.to_string(),
            "audience": "https://api.github.com"
        }),
    };

    let forged = e
        .decide(
            &req,
            Some(&child),
            None,
            AvailabilityClass::A3ExternalSideEffect,
        )
        .unwrap();
    assert!(
        !forged.decision,
        "raw parent_grant_id must not establish eligibility"
    );

    let chain = ValidatedGrantChain::try_validate(&[root.clone(), child.clone()], now, 0)
        .expect("attenuation-valid chain");
    let d = e
        .decide(
            &req,
            Some(&child),
            Some(&chain),
            AvailabilityClass::A3ExternalSideEffect,
        )
        .unwrap();
    assert!(d.decision, "validated lineage must be its own eligibility");

    // The same child grant is NOT eligibility for a different connection.
    let mut other = req.clone();
    other.context = json!({
        "connection_id": "connA",
        "connection_uuid": ConnectionId::new().to_string(),
        "audience": "https://api.github.com"
    });
    let denied = e
        .decide(
            &other,
            Some(&child),
            Some(&chain),
            AvailabilityClass::A3ExternalSideEffect,
        )
        .unwrap();
    assert!(
        !denied.decision,
        "a grant must not open somebody else's connection"
    );

    // And a ROOT grant without a tuple stays refused: lineage is the pass,
    // not mere possession of a grant object.
    let denied = e
        .decide(
            &req,
            Some(&root),
            None,
            AvailabilityClass::A3ExternalSideEffect,
        )
        .unwrap();
    assert!(
        !denied.decision,
        "a root grant still needs its relationship tuple"
    );
}

fn assurance_grant(now: DateTime<Utc>, action: &str, assurance: &str) -> Grant {
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
        actions: vec![action.to_owned()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: Some(assurance.to_owned()),
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

#[test]
fn client_assurance_property_is_not_evidence() {
    let mut e = engine_two_orgs();
    // Verified map says password; client claims mfa in the request body.
    e.assurance.insert("user:alice".into(), "pwd".into());
    let now = Utc::now();
    let grant = assurance_grant(now, "repository.read", "mfa");
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:alice".into(),
            properties: json!({"assurance": "mfa"}),
        },
        action: AuthZenAction {
            name: "repository.read".into(),
        },
        resource: AuthZenResource {
            type_: "connector_operation".into(),
            id: "repo:acme/catalog".into(),
        },
        context: json!({
            "connection_id": "connA",
            "audience": "https://api.github.com"
        }),
    };
    assert_eq!(
        e.decide(
            &req,
            Some(&grant),
            None,
            AvailabilityClass::A3ExternalSideEffect
        )
        .unwrap_err(),
        AuthzError::StepUpRequired("mfa".into())
    );
}

#[test]
fn connection_execute_allowed() {
    let e = engine_two_orgs();
    let now = Utc::now();
    let grant = assurance_grant(now, "pull_request.create", "mfa");
    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: "user:alice".into(),
            properties: json!({"assurance": "mfa"}),
        },
        action: AuthZenAction {
            name: "pull_request.create".into(),
        },
        resource: AuthZenResource {
            type_: "connector_operation".into(),
            id: "repo:acme/catalog".into(),
        },
        context: json!({
            "connection_id": "connA",
            "audience": "https://api.github.com"
        }),
    };
    let d = e
        .decide(
            &req,
            Some(&grant),
            None,
            AvailabilityClass::A3ExternalSideEffect,
        )
        .unwrap();
    assert!(d.decision);

    // Same subject, same granted action, a resource the grant never named.
    let mut elsewhere = req;
    elsewhere.resource.id = "repo:victim/secrets".into();
    let denied = e
        .decide(
            &elsewhere,
            Some(&grant),
            None,
            AvailabilityClass::A3ExternalSideEffect,
        )
        .unwrap();
    assert!(!denied.decision);
    assert_eq!(
        denied.context.get("reason").and_then(|v| v.as_str()),
        Some("grant_resource")
    );
}
