#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{Duration, Utc};
    use opensesame_domain::*;
    use serde_json::json;

    fn engine() -> PolicyEngine {
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
        e.relationships
            .write("connection:connA", "user", "agent:helper");
        e.assurance.insert("user:alice".into(), "mfa".into());
        e.assurance.insert("agent:helper".into(), "pwd".into());
        e
    }

    fn grant_for(actions: &[&str], aud: &[&str], assurance: &str) -> Grant {
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
            actions: actions.iter().map(|s| (*s).into()).collect(),
            resources: vec!["repo:acme/catalog".into()],
            constraints: GrantConstraints {
                audiences: aud.iter().map(|s| (*s).into()).collect(),
                not_before: None,
                expires_at: now + Duration::hours(1),
                required_assurance: Some(assurance.into()),
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
    fn colliding_display_names_still_isolated() {
        let e = engine();
        // Same display name "catalog" would collide; IDs differ.
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
        assert!(
            !e.decide(&req, None, AvailabilityClass::A2AuthorityRequired)
                .unwrap()
                .decision
        );
    }

    #[test]
    fn discovery_only_not_executable() {
        let e = engine();
        let g = grant_for(&["pull_request.create"], &["https://api.github.com"], "mfa");
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
                id: "github/acme".into(),
            },
            context: json!({
                "connection_id": "connA",
                "audience": "https://api.github.com",
                "discovery_only": true
            }),
        };
        let d = e
            .decide(&req, Some(&g), AvailabilityClass::A3ExternalSideEffect)
            .unwrap();
        assert!(!d.decision);
    }

    #[test]
    fn wrong_audience_denied() {
        let e = engine();
        let g = grant_for(&["pull_request.create"], &["https://api.github.com"], "mfa");
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
                id: "x".into(),
            },
            context: json!({
                "connection_id": "connA",
                "audience": "https://evil.example"
            }),
        };
        assert!(
            !e.decide(&req, Some(&g), AvailabilityClass::A3ExternalSideEffect)
                .unwrap()
                .decision
        );
    }

    #[test]
    fn step_up_when_assurance_insufficient() {
        let e = engine();
        let g = grant_for(
            &["pull_request.create"],
            &["https://api.github.com"],
            "phishing-resistant",
        );
        let req = AuthZenRequest {
            subject: AuthZenSubject {
                type_: "agent".into(),
                id: "agent:helper".into(),
                properties: json!({"assurance": "pwd"}),
            },
            action: AuthZenAction {
                name: "pull_request.create".into(),
            },
            resource: AuthZenResource {
                type_: "connector_operation".into(),
                // Inside the grant's resource scope, so assurance is what decides.
                id: "repo:acme/catalog".into(),
            },
            context: json!({
                "connection_id": "connA",
                "audience": "https://api.github.com"
            }),
        };
        assert_eq!(
            e.decide(&req, Some(&g), AvailabilityClass::A3ExternalSideEffect)
                .unwrap_err(),
            AuthzError::StepUpRequired("phishing-resistant".into())
        );
    }

    #[test]
    fn a1_preauthorized_without_offline_denied_when_no_quorum() {
        let mut e = engine();
        e.authority_quorum = false;
        let mut g = grant_for(&["repository.read"], &["https://api.github.com"], "mfa");
        g.constraints.offline_use = OfflineUse::Forbidden;
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
                id: "x".into(),
            },
            context: json!({"connection_id": "connA", "audience": "https://api.github.com"}),
        };
        assert_eq!(
            e.decide(&req, Some(&g), AvailabilityClass::A1Preauthorized)
                .unwrap_err(),
            AuthzError::AuthorityUnavailable
        );
    }

    #[test]
    fn policy_digest_stable() {
        let a = policy_version_digest();
        let b = policy_version_digest();
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:"));
    }
}
