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
            let offline_ok = grant
                .map(|g| g.constraints.offline_use == OfflineUse::PreAuthorized)
                .unwrap_or(false);
            if !offline_ok && !self.authority_quorum {
                return Err(AuthzError::AuthorityUnavailable);
            }
        }

        let subject = &req.subject.id;
        let object = format!("{}:{}", req.resource.type_, req.resource.id);
        // Relationship eligibility: connection users may execute connector_operation
        let rel_ok = match req.resource.type_.as_str() {
            "connector_operation" => {
                let conn = req
                    .context
                    .get("connection_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                self.relationships
                    .check(&format!("connection:{conn}"), "user", subject)
                    || self.relationships.check(&object, "executor", subject)
            }
            "project" => {
                self.relationships.check(&object, "viewer", subject)
                    || self.relationships.check(&object, "developer", subject)
                    || self.relationships.check(&object, "admin", subject)
            }
            // Authority use names the connection itself; the target is fenced by the
            // egress binding, not by a resource id.
            "connection" => {
                let conn = req
                    .context
                    .get("connection_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                self.relationships
                    .check(&format!("connection:{conn}"), "user", subject)
                    || self.relationships.check(&object, "user", subject)
            }
            "organization" => self.relationships.check(&object, "member", subject),
            _ => self.relationships.check(&object, "viewer", subject),
        };

        if !rel_ok {
            return Ok(deny(req, "relationship"));
        }

        if let Some(g) = grant {
            if !g.actions.iter().any(|a| a == &req.action.name) {
                return Ok(deny(req, "grant_action"));
            }
            // The grant names its resources as well as its actions; skipping this
            // check let a grant for one repository authorize the same action
            // against any other. Only `connector_operation` ids share the grant's
            // resource vocabulary — a `connection` request is fenced by the
            // authority binding instead.
            if req.resource.type_ == "connector_operation" && !g.permits_resource(&req.resource.id)
            {
                return Ok(deny(req, "grant_resource"));
            }
            if let Some(aud) = req.context.get("audience").and_then(|v| v.as_str()) {
                if !g.constraints.audiences.is_empty()
                    && !g.constraints.audiences.iter().any(|a| a == aud)
                {
                    return Ok(deny(req, "audience"));
                }
            }
            if !g.constraints.raw_credential_export && req.action.name == "credential.export" {
                return Ok(deny(req, "export_default_deny"));
            }
            if let Some(required) = &g.constraints.required_assurance {
                let have = self
                    .assurance
                    .get(subject)
                    .cloned()
                    .or_else(|| {
                        req.subject
                            .properties
                            .get("assurance")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();
                if !assurance_satisfies(&have, required) {
                    return Err(AuthzError::StepUpRequired(required.clone()));
                }
            }
        } else if req.action.name == "credential.export" {
            return Ok(deny(req, "export_default_deny"));
        }

        // Discoverable MCP tool != executable
        if req.context.get("discovery_only").and_then(|v| v.as_bool()) == Some(true) {
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
                budgets: Default::default(),
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
