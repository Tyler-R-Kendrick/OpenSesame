use crate::{
    ActorId, ActorInstanceId, ClientId, ConnectionId, DomainError, EnvironmentId, GrantId,
    OrganizationId, PrincipalId, ProjectId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfflineUse {
    Forbidden,
    ReadOnly,
    PreAuthorized,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantConstraints {
    pub audiences: Vec<String>,
    pub not_before: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub required_assurance: Option<String>,
    pub authentication_max_age_seconds: Option<u64>,
    pub allowed_networks: Vec<String>,
    pub parameter_rules_digest: Option<String>,
    pub budgets: std::collections::BTreeMap<String, i64>,
    pub maximum_delegation_depth: u32,
    pub offline_use: OfflineUse,
    pub raw_credential_export: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grant {
    pub id: GrantId,
    pub version: u32,
    pub issuer_principal_id: PrincipalId,
    pub beneficiary_principal_id: PrincipalId,
    pub actor_id: Option<ActorId>,
    pub client_id: Option<ClientId>,
    pub actor_instance_id: Option<ActorInstanceId>,
    pub proof_key_thumbprint: Option<String>,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub environment_id: Option<EnvironmentId>,
    pub connection_id: Option<ConnectionId>,
    pub actions: Vec<String>,
    pub resources: Vec<String>,
    pub constraints: GrantConstraints,
    pub parent_grant_id: Option<GrantId>,
    pub delegation_depth: u32,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Grant {
    /// # Errors
    /// Returns an error when the grant is revoked or outside `[not_before, expires_at)`.
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.revoked_at.is_some() {
            return Err(DomainError::GrantRevoked);
        }
        if !interval_contains(
            now,
            self.constraints.not_before,
            self.constraints.expires_at,
        ) {
            return Err(DomainError::GrantTimeWindow);
        }
        Ok(())
    }

    /// True when `resource` falls inside the grant's resource scope.
    ///
    /// A grant names both the actions and the resources it covers; checking only
    /// the actions leaves the resource scope decorative, so a grant for one
    /// repository would authorize the same action anywhere. `*` covers everything
    /// and a trailing `/*` or `:*` covers a segment-bounded subtree — a bare
    /// prefix never widens, and an empty list covers nothing.
    #[must_use]
    pub fn permits_resource(&self, resource: &str) -> bool {
        self.resources
            .iter()
            .any(|pattern| resource_pattern_matches(pattern, resource))
    }

    /// Child grants may only attenuate authority.
    /// # Errors
    /// Returns an error when the child widens the parent.
    pub fn validate_attenuation(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
        crate::grant_attenuation::validate_lineage_pointers(parent, child)?;
        crate::grant_lineage::validate_issuance(parent, child)?;
        if !is_subset(&child.actions, &parent.actions) {
            return Err(DomainError::GrantAttenuation("actions expanded".into()));
        }
        if !crate::grant_attenuation::resources_attenuate(&child.resources, &parent.resources) {
            return Err(DomainError::GrantAttenuation("resources expanded".into()));
        }
        // Empty parent audiences means unrestricted, so a child may introduce a
        // list; a parent that names audiences can neither be widened past them
        // nor have them cleared away.
        if !parent.constraints.audiences.is_empty() {
            if child.constraints.audiences.is_empty() {
                return Err(DomainError::GrantAttenuation(
                    "audiences cleared under restricted parent".into(),
                ));
            }
            if !is_subset(&child.constraints.audiences, &parent.constraints.audiences) {
                return Err(DomainError::GrantAttenuation("audiences expanded".into()));
            }
        }
        crate::grant_attenuation::validate_constraint_attenuation(
            &parent.constraints,
            &child.constraints,
        )?;
        Ok(())
    }

    /// A replacement child may only narrow further (ADR 0046 decision 10).
    ///
    /// Post-claim edits are revoke-and-replace: the owner mints a narrower
    /// grant and the old child dies. The replacement must attenuate against
    /// the parent — it is still a delegation — **and** against the grant it
    /// replaces, because "edit" must never be a door to widening: a caller
    /// who could replace a read-only child with a read-write one would have
    /// re-minted authority the ceremony never granted. Widening is a new
    /// offer and a new ceremony, never an edit.
    ///
    /// The replacement keeps the current child's position in the chain
    /// (same depth, same parent); only its authority shrinks.
    ///
    /// # Errors
    ///
    /// Returns an attenuation error if the replacement changes lineage or
    /// widens either the parent or current child's authority.
    pub fn validate_replacement(
        parent: &Grant,
        current: &Grant,
        replacement: &Grant,
    ) -> Result<(), DomainError> {
        if replacement.delegation_depth != current.delegation_depth {
            return Err(DomainError::GrantAttenuation(
                "replacement must keep the chain position it replaces".into(),
            ));
        }
        if replacement.parent_grant_id != current.parent_grant_id {
            return Err(DomainError::GrantAttenuation(
                "replacement must keep the parent it replaces".into(),
            ));
        }
        Grant::validate_attenuation(parent, replacement)?;
        // Same checks, one generation flat: the replacement is a sibling of
        // the current child, so the depth-increment rule does not apply, but
        // every authority dimension must still be a subset of what it
        // replaces.
        if !is_subset(&replacement.actions, &current.actions) {
            return Err(DomainError::GrantAttenuation(
                "replacement widens actions".into(),
            ));
        }
        if !is_subset(
            &replacement.constraints.audiences,
            &current.constraints.audiences,
        ) {
            return Err(DomainError::GrantAttenuation(
                "replacement widens audiences".into(),
            ));
        }
        if !crate::grant_attenuation::resources_attenuate(
            &replacement.resources,
            &current.resources,
        ) {
            return Err(DomainError::GrantAttenuation(
                "replacement widens resources".into(),
            ));
        }
        if replacement.constraints.raw_credential_export
            && !current.constraints.raw_credential_export
        {
            return Err(DomainError::GrantAttenuation(
                "replacement adds export privilege".into(),
            ));
        }
        if replacement.constraints.maximum_delegation_depth
            > current.constraints.maximum_delegation_depth
        {
            return Err(DomainError::GrantAttenuation(
                "replacement widens re-delegation".into(),
            ));
        }
        crate::grant_attenuation::validate_constraint_narrowing(
            &current.constraints,
            &replacement.constraints,
        )?;
        Ok(())
    }
}

/// Inclusive-start, exclusive-end validity window. Extracted so Kani can
/// check the clock arithmetic without constructing a full [`Grant`].
#[must_use]
pub fn interval_contains(
    now: DateTime<Utc>,
    not_before: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
) -> bool {
    if let Some(nbf) = not_before {
        if now < nbf {
            return false;
        }
    }
    now < expires_at
}

/// Match a grant resource pattern. Wildcards keep their separator so
/// `repo:acme/*` cannot reach `repo:acme-private/secrets`.
#[must_use]
pub fn resource_pattern_matches(pattern: &str, resource: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == resource {
        return true;
    }
    for sep in ['/', ':'] {
        let suffix = format!("{sep}*");
        if let Some(prefix) = pattern.strip_suffix('*') {
            if pattern.ends_with(&suffix) && !prefix.is_empty() {
                return resource.len() > prefix.len() && resource.starts_with(prefix);
            }
        }
    }
    false
}

fn is_subset(child: &[String], parent: &[String]) -> bool {
    child.iter().all(|c| parent.iter().any(|p| p == c))
}

#[cfg(test)]
#[path = "grant_unit_tests.rs"]
mod tests;

#[cfg(kani)]
mod kani_proofs {
    use super::*;
    use chrono::TimeZone;

    fn dt(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(secs.clamp(0, 2_000_000_000), 0)
            .single()
            .unwrap()
    }

    #[kani::proof]
    fn interval_half_open() {
        let now: i64 = kani::any();
        kani::assume(now >= 0 && now < 10_000);
        let nbf = dt(now.saturating_sub(10));
        let exp = dt(now.saturating_add(10));
        let t = dt(now);
        assert!(interval_contains(t, Some(nbf), exp));
        assert!(!interval_contains(exp, Some(nbf), exp));
    }
}
