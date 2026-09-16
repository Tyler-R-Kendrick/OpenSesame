//! Fixtures shared by the policy contract suites.
//!
//! Each integration test is its own binary and uses the subset of these it
//! needs, so the module is compiled several times with different fixtures live.
#![allow(dead_code)]

use chrono::{DateTime, Duration, Utc};
use opensesame_authz::{
    AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, PolicyEngine,
};
use opensesame_domain::{
    Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId,
};
use serde_json::{json, Value};

pub const SUBJECT: &str = "user:alice";
pub const AUDIENCE: &str = "https://api.github.com";
pub const RESOURCE: &str = "repo:acme/catalog";

/// An engine that knows Alice holds `connection:connA` and authenticated with MFA.
#[must_use]
pub fn engine() -> PolicyEngine {
    let mut engine = PolicyEngine::default();
    engine
        .relationships
        .write("connection:connA", "user", SUBJECT);
    engine.assurance.insert(SUBJECT.to_owned(), "mfa".into());
    engine
}

/// A grant for one action on one resource, with no requirements of its own.
#[must_use]
pub fn grant(now: DateTime<Utc>, action: &str) -> Grant {
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
        resources: vec![RESOURCE.to_owned()],
        constraints: GrantConstraints {
            audiences: vec![AUDIENCE.to_owned()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: None,
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

/// A connector-operation request for `action` on [`RESOURCE`], naming [`AUDIENCE`].
#[must_use]
pub fn request(action: &str) -> AuthZenRequest {
    request_with(
        action,
        "connector_operation",
        RESOURCE,
        json!({"connection_id": "connA", "audience": AUDIENCE}),
    )
}

#[must_use]
pub fn request_with(
    action: &str,
    resource_type: &str,
    resource_id: &str,
    context: Value,
) -> AuthZenRequest {
    AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: SUBJECT.to_owned(),
            properties: json!({}),
        },
        action: AuthZenAction {
            name: action.to_owned(),
        },
        resource: AuthZenResource {
            type_: resource_type.to_owned(),
            id: resource_id.to_owned(),
        },
        context,
    }
}
