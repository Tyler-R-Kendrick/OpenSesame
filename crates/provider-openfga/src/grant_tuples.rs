//! GA-F-02 / GA-F-04 — map a Host `Grant` onto OpenFGA tuple keys.
//!
//! Mirrors `packages/policy/src/authority-tuples.ts`. Projection is a cache
//! with a stated position, never authority. This module only derives the
//! additive relationship tuples a projector may write for one grant.

use opensesame_domain::Grant;
use std::collections::HashSet;

use crate::TupleKey;

/// Why a grant must not be projected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GrantTupleMappingError {
    Revoked,
    CohortGrantee,
    EmptyActions,
    EmptyResources,
    UnmappedScope,
}

impl GrantTupleMappingError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Revoked => "revoked",
            Self::CohortGrantee => "cohort_grantee",
            Self::EmptyActions => "empty_actions",
            Self::EmptyResources => "empty_resources",
            Self::UnmappedScope => "unmapped_scope",
        }
    }

    #[must_use]
    pub fn message(&self) -> &'static str {
        match self {
            Self::Revoked => "revoked grants project nothing",
            Self::CohortGrantee => {
                "cohort must never appear as an OpenFGA grantee object for a grant"
            }
            Self::EmptyActions => "a grant with no actions projects nothing",
            Self::EmptyResources => "a grant with no resources projects nothing",
            Self::UnmappedScope => {
                "grant has no connection, project, or typed resource to project"
            }
        }
    }
}

/// Result of mapping one grant to OpenFGA tuples.
pub type GrantTupleMappingResult = Result<Vec<TupleKey>, GrantTupleMappingError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResourceKind {
    VaultItem,
    VaultCollection,
    AccessDomain,
    Connection,
    Project,
    Other,
}

struct ParsedResource {
    object: String,
    kind: ResourceKind,
}

const WRITEISH_TOKENS: &[&str] = &[
    "write", "admin", "delete", "create", "update", "mutate", "invoke", "execute",
    "export",
];

fn is_writeish(actions: &[String]) -> bool {
    for action in actions {
        let lower = action.to_ascii_lowercase();
        for token in WRITEISH_TOKENS {
            // Mirror the TS boundary: token at start/end or beside . : _
            if lower == *token {
                return true;
            }
            for sep in ['.', ':', '_'] {
                if lower.starts_with(&format!("{token}{sep}"))
                    || lower.ends_with(&format!("{sep}{token}"))
                    || lower.contains(&format!("{sep}{token}{sep}"))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn project_relation(actions: &[String]) -> &'static str {
    if is_writeish(actions) {
        "developer"
    } else {
        "viewer"
    }
}

fn vault_relation(actions: &[String]) -> &'static str {
    if is_writeish(actions) {
        "writer"
    } else {
        "reader"
    }
}

fn domain_relation(actions: &[String]) -> &'static str {
    if is_writeish(actions) {
        "admin"
    } else {
        "member"
    }
}

fn subject_user(grant: &Grant) -> String {
    format!("user:{}", grant.beneficiary_principal_id)
}

fn parse_resource_object(resource: &str) -> Result<ParsedResource, GrantTupleMappingError> {
    let trimmed = resource.trim();
    if trimmed.starts_with("cohort:") || trimmed.contains("cohort#") {
        return Err(GrantTupleMappingError::CohortGrantee);
    }
    let (kind, object) = if trimmed.starts_with("vault_item:") {
        (ResourceKind::VaultItem, trimmed.to_string())
    } else if trimmed.starts_with("vault_collection:") {
        (ResourceKind::VaultCollection, trimmed.to_string())
    } else if trimmed.starts_with("access_domain:") {
        (ResourceKind::AccessDomain, trimmed.to_string())
    } else if trimmed.starts_with("connection:") {
        (ResourceKind::Connection, trimmed.to_string())
    } else if trimmed.starts_with("project:") {
        (ResourceKind::Project, trimmed.to_string())
    } else {
        (ResourceKind::Other, trimmed.to_string())
    };
    Ok(ParsedResource { object, kind })
}

fn typed_object(prefix: &str, id: &str) -> String {
    let trimmed = id.trim();
    let head = format!("{prefix}:");
    if trimmed.starts_with(&head) {
        trimmed.to_string()
    } else {
        format!("{head}{trimmed}")
    }
}

fn push_tuple(tuples: &mut Vec<TupleKey>, seen: &mut HashSet<String>, tuple: TupleKey) {
    let key = format!("{}#{}@{}", tuple.object, tuple.relation, tuple.user);
    if seen.insert(key) {
        tuples.push(tuple);
    }
}

fn push_scope_tuples(grant: &Grant, tuples: &mut Vec<TupleKey>, seen: &mut HashSet<String>) {
    let user = subject_user(grant);
    if let Some(connection_id) = &grant.connection_id {
        push_tuple(
            tuples,
            seen,
            TupleKey {
                user: user.clone(),
                relation: "user".into(),
                object: typed_object("connection", &connection_id.to_string()),
            },
        );
    }
    if let Some(project_id) = &grant.project_id {
        push_tuple(
            tuples,
            seen,
            TupleKey {
                user: user.clone(),
                relation: project_relation(&grant.actions).into(),
                object: typed_object("project", &project_id.to_string()),
            },
        );
    }
}

fn push_parsed_resource(
    grant: &Grant,
    parsed: &ParsedResource,
    tuples: &mut Vec<TupleKey>,
    seen: &mut HashSet<String>,
) -> bool {
    let user = subject_user(grant);
    match parsed.kind {
        ResourceKind::Connection => {
            push_tuple(
                tuples,
                seen,
                TupleKey {
                    user,
                    relation: "user".into(),
                    object: parsed.object.clone(),
                },
            );
            true
        }
        ResourceKind::Project => {
            push_tuple(
                tuples,
                seen,
                TupleKey {
                    user,
                    relation: project_relation(&grant.actions).into(),
                    object: parsed.object.clone(),
                },
            );
            true
        }
        ResourceKind::VaultItem | ResourceKind::VaultCollection => {
            push_tuple(
                tuples,
                seen,
                TupleKey {
                    user,
                    relation: vault_relation(&grant.actions).into(),
                    object: parsed.object.clone(),
                },
            );
            true
        }
        ResourceKind::AccessDomain => {
            push_tuple(
                tuples,
                seen,
                TupleKey {
                    user,
                    relation: domain_relation(&grant.actions).into(),
                    object: parsed.object.clone(),
                },
            );
            true
        }
        ResourceKind::Other => false,
    }
}

fn assert_projectable(grant: &Grant) -> Result<(), GrantTupleMappingError> {
    if grant.revoked_at.is_some() {
        return Err(GrantTupleMappingError::Revoked);
    }
    if grant.actions.is_empty() {
        return Err(GrantTupleMappingError::EmptyActions);
    }
    if grant.resources.is_empty() {
        return Err(GrantTupleMappingError::EmptyResources);
    }
    Ok(())
}

/// Derive the OpenFGA tuples a projector may write for `grant`.
///
/// # Errors
///
/// Returns a mapping error when the grant must not be projected.
pub fn grant_to_openfga_tuples(grant: &Grant) -> GrantTupleMappingResult {
    assert_projectable(grant)?;

    let mut tuples = Vec::new();
    let mut seen = HashSet::new();
    push_scope_tuples(grant, &mut tuples, &mut seen);

    let mut mapped_resource = false;
    for resource in &grant.resources {
        let parsed = parse_resource_object(resource)?;
        if push_parsed_resource(grant, &parsed, &mut tuples, &mut seen) {
            mapped_resource = true;
        }
    }

    if tuples.is_empty()
        && grant.connection_id.is_none()
        && grant.project_id.is_none()
        && !mapped_resource
    {
        return Err(GrantTupleMappingError::UnmappedScope);
    }

    Ok(tuples)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use opensesame_domain::{
        ConnectionId, GrantConstraints, OfflineUse, OrganizationId, PrincipalId, ProjectId,
    };

    fn sample_grant() -> Grant {
        let now = Utc::now();
        Grant {
            id: opensesame_domain::GrantId::new(),
            version: 1,
            issuer_principal_id: PrincipalId::new(),
            beneficiary_principal_id: PrincipalId::new(),
            actor_id: None,
            client_id: None,
            actor_instance_id: None,
            proof_key_thumbprint: None,
            organization_id: OrganizationId::new(),
            project_id: Some(ProjectId::new()),
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: vec!["secret.read".into()],
            resources: vec!["vault/item/*".into()],
            constraints: GrantConstraints {
                audiences: vec!["host".into()],
                not_before: None,
                expires_at: now + Duration::days(30),
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: Default::default(),
                maximum_delegation_depth: 2,
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
    fn projects_connection_user_and_project_viewer_for_read_grant() {
        let grant = sample_grant();
        let tuples = grant_to_openfga_tuples(&grant).expect("map");
        let user = format!("user:{}", grant.beneficiary_principal_id);
        assert!(tuples.iter().any(|t| {
            t.user == user && t.relation == "user" && t.object.starts_with("connection:")
        }));
        assert!(tuples.iter().any(|t| {
            t.user == user && t.relation == "viewer" && t.object.starts_with("project:")
        }));
    }

    #[test]
    fn refuses_revoked_grants() {
        let mut grant = sample_grant();
        grant.revoked_at = Some(Utc::now());
        assert!(matches!(
            grant_to_openfga_tuples(&grant),
            Err(GrantTupleMappingError::Revoked)
        ));
    }

    #[test]
    fn refuses_cohort_shaped_resources() {
        let mut grant = sample_grant();
        grant.resources = vec!["cohort:eng".into()];
        assert!(matches!(
            grant_to_openfga_tuples(&grant),
            Err(GrantTupleMappingError::CohortGrantee)
        ));
    }
}
