use crate::{policy_version_digest, AuthZenDecision, AuthZenObligation, AuthZenRequest};
use opensesame_domain::{AvailabilityClass, Grant, OfflineUse};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthzError {
    #[error("denied: {0}")]
    Denied(String),
    #[error("step-up required: {0}")]
    StepUpRequired(String),
    #[error("authority quorum unavailable")]
    AuthorityUnavailable,
}

#[derive(Clone, Debug, Default)]
pub struct RelationshipStore {
    /// tuple key "object#relation@user"
    tuples: HashSet<String>,
}

impl RelationshipStore {
    pub fn write(&mut self, object: &str, relation: &str, user: &str) {
        self.tuples.insert(format!("{object}#{relation}@{user}"));
    }

    #[must_use]
    pub fn check(&self, object: &str, relation: &str, user: &str) -> bool {
        self.tuples.contains(&format!("{object}#{relation}@{user}"))
    }
}

#[derive(Clone, Debug)]
pub struct PolicyEngine {
    pub relationships: RelationshipStore,
    pub authority_quorum: bool,
    /// subject -> assurance level
    pub assurance: HashMap<String, String>,
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self {
            relationships: RelationshipStore::default(),
            authority_quorum: true,
            assurance: HashMap::new(),
        }
    }
}

impl PolicyEngine {
    fn relationship_allowed(&self, req: &AuthZenRequest, grant: Option<&Grant>) -> bool {
        let subject = &req.subject.id;
        let object = format!("{}:{}", req.resource.type_, req.resource.id);
        let connection = || {
            req.context
                .get("connection_id")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        };
        // Delegated grants were attenuation-validated when claimed. Their
        // lineage and exact connection binding replace the owner's tuple;
        // requiring both would make every valid delegated exercise fail.
        let delegated_capability = grant.is_some_and(|grant| {
            grant.parent_grant_id.is_some()
                && req
                    .context
                    .get("connection_uuid")
                    .and_then(|value| value.as_str())
                    .is_some_and(|connection_id| {
                        grant.connection_id.map(|id| id.to_string()).as_deref()
                            == Some(connection_id)
                    })
        });
        match req.resource.type_.as_str() {
            "connector_operation" => {
                self.relationships
                    .check(&format!("connection:{}", connection()), "user", subject)
                    || self.relationships.check(&object, "executor", subject)
                    || delegated_capability
            }
            "project" => ["viewer", "developer", "admin"]
                .iter()
                .any(|relation| self.relationships.check(&object, relation, subject)),
            // Authority use names the connection itself; egress binding fences the target.
            "connection" => {
                self.relationships
                    .check(&format!("connection:{}", connection()), "user", subject)
                    || self.relationships.check(&object, "user", subject)
                    || delegated_capability
            }
            "organization" => self.relationships.check(&object, "member", subject),
            _ => self.relationships.check(&object, "viewer", subject),
        }
    }

    fn grant_denial(
        &self,
        req: &AuthZenRequest,
        grant: &Grant,
    ) -> Result<Option<&'static str>, AuthzError> {
        if !grant
            .actions
            .iter()
            .any(|action| action == &req.action.name)
        {
            return Ok(Some("grant_action"));
        }
        if req.resource.type_ == "connector_operation" && !grant.permits_resource(&req.resource.id)
        {
            return Ok(Some("grant_resource"));
        }
        let audience_denied = req
            .context
            .get("audience")
            .and_then(|value| value.as_str())
            .is_some_and(|audience| {
                !grant.constraints.audiences.is_empty()
                    && !grant
                        .constraints
                        .audiences
                        .iter()
                        .any(|allowed| allowed == audience)
            });
        if audience_denied {
            return Ok(Some("audience"));
        }
        if !grant.constraints.raw_credential_export && req.action.name == "credential.export" {
            return Ok(Some("export_default_deny"));
        }
        if let Some(required) = &grant.constraints.required_assurance {
            let have = self
                .assurance
                .get(&req.subject.id)
                .cloned()
                .or_else(|| {
                    req.subject
                        .properties
                        .get("assurance")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            if !assurance_satisfies(&have, required) {
                return Err(AuthzError::StepUpRequired(required.clone()));
            }
        }
        Ok(None)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn decide(
        &self,
        req: &AuthZenRequest,
        grant: Option<&Grant>,
        class: AvailabilityClass,
    ) -> Result<AuthZenDecision, AuthzError> {
        if class.requires_authority_quorum() && !self.authority_quorum {
            return Err(AuthzError::AuthorityUnavailable);
        }
        if class == AvailabilityClass::A1Preauthorized {
            let offline_ok =
                grant.is_some_and(|g| g.constraints.offline_use == OfflineUse::PreAuthorized);
            if !offline_ok && !self.authority_quorum {
                return Err(AuthzError::AuthorityUnavailable);
            }
        }

        if !self.relationship_allowed(req, grant) {
            return Ok(deny(req, "relationship"));
        }

        if let Some(reason) = grant
            .map(|value| self.grant_denial(req, value))
            .transpose()?
        {
            if let Some(reason) = reason {
                return Ok(deny(req, reason));
            }
        } else if req.action.name == "credential.export" {
            return Ok(deny(req, "export_default_deny"));
        }

        // Discoverable MCP tool != executable
        if req
            .context
            .get("discovery_only")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            return Ok(deny(req, "discovery_not_execute"));
        }

        Ok(AuthZenDecision {
            decision: true,
            decision_id: format!("dec:{}", Uuid::new_v4()),
            policy_version_digest: policy_version_digest(),
            obligations: vec![AuthZenObligation {
                id: "receipt.required".into(),
                attributes: json!({"signed": true}),
            }],
            context: json!({"action": req.action.name}),
        })
    }
}

fn deny(req: &AuthZenRequest, reason: &str) -> AuthZenDecision {
    AuthZenDecision {
        decision: false,
        decision_id: format!("dec:{}", Uuid::new_v4()),
        policy_version_digest: policy_version_digest(),
        obligations: vec![],
        context: json!({"reason": reason, "action": req.action.name}),
    }
}

fn assurance_satisfies(have: &str, required: &str) -> bool {
    let rank = |a: &str| match a {
        "phishing-resistant" => 3,
        "mfa" => 2,
        "pwd" | "password" => 1,
        _ => 0,
    };
    rank(have) >= rank(required)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthZenAction, AuthZenResource, AuthZenSubject};
    use chrono::{Duration, Utc};
    use opensesame_domain::*;

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
            .decide(&req, None, AvailabilityClass::A2AuthorityRequired)
            .unwrap();
        assert!(!d.decision);
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
            .decide(&req, None, AvailabilityClass::A2AuthorityRequired)
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
            e.decide(&req, None, AvailabilityClass::A2AuthorityRequired)
                .unwrap_err(),
            AuthzError::AuthorityUnavailable
        );
    }

    #[test]
    fn contract_a_delegated_grant_is_eligibility_for_its_own_connection_only() {
        // No tuple exists for the delegate: eligibility must come from the
        // grant's lineage, and only for the connection the grant names.
        let e = engine_two_orgs();
        let now = Utc::now();
        let connection = ConnectionId::new();
        let child = Grant {
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
                budgets: Default::default(),
                maximum_delegation_depth: 0,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: false,
            },
            parent_grant_id: Some(GrantId::new()),
            delegation_depth: 1,
            created_at: now,
            revoked_at: None,
        };
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
        let d = e
            .decide(&req, Some(&child), AvailabilityClass::A3ExternalSideEffect)
            .unwrap();
        assert!(
            d.decision,
            "delegated capability must be its own eligibility"
        );

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
                AvailabilityClass::A3ExternalSideEffect,
            )
            .unwrap();
        assert!(
            !denied.decision,
            "a grant must not open somebody else's connection"
        );

        // And a ROOT grant without a tuple stays refused: lineage is the pass,
        // not mere possession of a grant object.
        let mut root = child.clone();
        root.parent_grant_id = None;
        root.delegation_depth = 0;
        let denied = e
            .decide(&req, Some(&root), AvailabilityClass::A3ExternalSideEffect)
            .unwrap();
        assert!(
            !denied.decision,
            "a root grant still needs its relationship tuple"
        );
    }

    #[test]
    fn connection_execute_allowed() {
        let e = engine_two_orgs();
        let now = Utc::now();
        let grant = Grant {
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
            actions: vec!["pull_request.create".into()],
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
                raw_credential_export: false,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        };
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
            .decide(&req, Some(&grant), AvailabilityClass::A3ExternalSideEffect)
            .unwrap();
        assert!(d.decision);

        // Same subject, same granted action, a resource the grant never named.
        let mut elsewhere = req;
        elsewhere.resource.id = "repo:victim/secrets".into();
        let denied = e
            .decide(
                &elsewhere,
                Some(&grant),
                AvailabilityClass::A3ExternalSideEffect,
            )
            .unwrap();
        assert!(!denied.decision);
        assert_eq!(
            denied.context.get("reason").and_then(|v| v.as_str()),
            Some("grant_resource")
        );
    }
}
