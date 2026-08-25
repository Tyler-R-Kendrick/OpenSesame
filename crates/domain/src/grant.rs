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
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn validate_attenuation(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
        if child.organization_id != parent.organization_id {
            return Err(DomainError::OrganizationMismatch);
        }
        if child.delegation_depth != parent.delegation_depth + 1 {
            return Err(DomainError::GrantAttenuation(
                "delegation_depth must increment by 1".into(),
            ));
        }
        if child.constraints.maximum_delegation_depth > parent.constraints.maximum_delegation_depth
        {
            return Err(DomainError::GrantAttenuation(
                "maximum_delegation_depth expanded".into(),
            ));
        }
        if child.delegation_depth > parent.constraints.maximum_delegation_depth {
            return Err(DomainError::DelegationDepthExceeded);
        }
        if child.constraints.expires_at > parent.constraints.expires_at {
            return Err(DomainError::GrantAttenuation("lifetime expanded".into()));
        }
        if child.constraints.raw_credential_export && !parent.constraints.raw_credential_export {
            return Err(DomainError::GrantAttenuation(
                "export privilege expanded".into(),
            ));
        }
        if !is_subset(&child.actions, &parent.actions) {
            return Err(DomainError::GrantAttenuation("actions expanded".into()));
        }
        if !is_subset(&child.resources, &parent.resources) {
            return Err(DomainError::GrantAttenuation("resources expanded".into()));
        }
        if !is_subset(&child.constraints.audiences, &parent.constraints.audiences) {
            return Err(DomainError::GrantAttenuation("audiences expanded".into()));
        }
        for (k, v) in &child.constraints.budgets {
            match parent.constraints.budgets.get(k) {
                Some(pv) if v <= pv => {}
                _ => {
                    return Err(DomainError::GrantAttenuation(format!(
                        "budget expanded for {k}"
                    )))
                }
            }
        }
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
        if !is_subset(&replacement.resources, &current.resources) {
            return Err(DomainError::GrantAttenuation(
                "replacement widens resources".into(),
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
        if replacement.constraints.expires_at > current.constraints.expires_at {
            return Err(DomainError::GrantAttenuation(
                "replacement extends lifetime".into(),
            ));
        }
        if replacement.constraints.maximum_delegation_depth
            > current.constraints.maximum_delegation_depth
        {
            return Err(DomainError::GrantAttenuation(
                "replacement widens re-delegation".into(),
            ));
        }
        if replacement.constraints.raw_credential_export
            && !current.constraints.raw_credential_export
        {
            return Err(DomainError::GrantAttenuation(
                "replacement adds export privilege".into(),
            ));
        }
        for (k, v) in &replacement.constraints.budgets {
            match current.constraints.budgets.get(k) {
                Some(cv) if v <= cv => {}
                _ => {
                    return Err(DomainError::GrantAttenuation(format!(
                        "replacement raises budget for {k}"
                    )))
                }
            }
        }
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
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn sample_parent() -> Grant {
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
            project_id: Some(ProjectId::new()),
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: vec!["pull_request.create".into(), "repository.read".into()],
            resources: vec!["repo:acme/catalog".into(), "repo:acme/other".into()],
            constraints: GrantConstraints {
                audiences: vec!["https://api.github.com".into()],
                not_before: None,
                expires_at: now + Duration::hours(1),
                required_assurance: Some("mfa".into()),
                authentication_max_age_seconds: Some(600),
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
    fn attenuation_ok() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.id = GrantId::new();
        child.parent_grant_id = Some(parent.id);
        child.delegation_depth = 1;
        child.actions = vec!["repository.read".into()];
        child.resources = vec!["repo:acme/catalog".into()];
        child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
        child.constraints.budgets.insert("calls".into(), 5);
        child.constraints.maximum_delegation_depth = 0;
        assert!(Grant::validate_attenuation(&parent, &child).is_ok());
    }

    #[test]
    fn contract_a_replacement_may_only_narrow() {
        let parent = sample_parent();
        let mut current = parent.clone();
        current.id = GrantId::new();
        current.parent_grant_id = Some(parent.id);
        current.delegation_depth = 1;
        current.actions = vec!["repository.read".into(), "pull_request.create".into()];
        current.resources = vec!["repo:acme/catalog".into(), "repo:acme/other".into()];
        current.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
        current.constraints.budgets.insert("calls".into(), 5);
        current.constraints.maximum_delegation_depth = 0;

        // Narrowing: fewer actions, fewer resources, shorter life, lower budget.
        let mut narrower = current.clone();
        narrower.id = GrantId::new();
        narrower.actions = vec!["repository.read".into()];
        narrower.resources = vec!["repo:acme/catalog".into()];
        narrower.constraints.expires_at = current.constraints.expires_at - Duration::minutes(1);
        narrower.constraints.budgets.insert("calls".into(), 2);
        assert!(Grant::validate_replacement(&parent, &current, &narrower).is_ok());
    }

    #[test]
    fn adversarial_a_replacement_cannot_widen_past_the_child_it_replaces() {
        // The parent allows both actions, so attenuation against the parent
        // alone would pass — which is exactly the hole: an "edit" that grows
        // back what the current child had already given up.
        let parent = sample_parent();
        let mut current = parent.clone();
        current.id = GrantId::new();
        current.parent_grant_id = Some(parent.id);
        current.delegation_depth = 1;
        current.actions = vec!["repository.read".into()];
        current.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
        current.constraints.maximum_delegation_depth = 0;
        current.constraints.budgets.insert("calls".into(), 3);

        let mut wider = current.clone();
        wider.id = GrantId::new();
        wider.actions = vec!["repository.read".into(), "pull_request.create".into()];
        assert!(Grant::validate_attenuation(&parent, &wider).is_ok());
        assert!(Grant::validate_replacement(&parent, &current, &wider).is_err());

        // Same for lifetime, budgets, and chain position.
        let mut longer = current.clone();
        longer.id = GrantId::new();
        longer.constraints.expires_at = current.constraints.expires_at + Duration::minutes(1);
        assert!(Grant::validate_replacement(&parent, &current, &longer).is_err());

        let mut richer = current.clone();
        richer.id = GrantId::new();
        richer.constraints.budgets.insert("calls".into(), 4);
        assert!(Grant::validate_replacement(&parent, &current, &richer).is_err());

        let mut deeper = current.clone();
        deeper.id = GrantId::new();
        deeper.delegation_depth = 2;
        assert!(Grant::validate_replacement(&parent, &current, &deeper).is_err());
    }

    #[test]
    fn cannot_expand_actions() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.parent_grant_id = Some(parent.id);
        child.delegation_depth = 1;
        child.actions.push("admin.destroy".into());
        assert!(Grant::validate_attenuation(&parent, &child).is_err());
    }

    #[test]
    fn interval_contains_is_half_open() {
        let nbf = Utc.timestamp_opt(10, 0).unwrap();
        let exp = Utc.timestamp_opt(20, 0).unwrap();
        assert!(!interval_contains(
            Utc.timestamp_opt(9, 0).unwrap(),
            Some(nbf),
            exp
        ));
        assert!(interval_contains(nbf, Some(nbf), exp));
        assert!(!interval_contains(exp, Some(nbf), exp));
    }

    #[test]
    fn resource_scope_is_enforced_with_segment_boundaries() {
        let mut g = sample_parent();
        assert!(g.permits_resource("repo:acme/catalog"));
        assert!(!g.permits_resource("repo:victim/secrets"));
        // A named resource must not reach a longer sibling name.
        assert!(!g.permits_resource("repo:acme/catalog-private"));

        g.resources = vec!["repo:acme/*".into()];
        assert!(g.permits_resource("repo:acme/catalog"));
        assert!(!g.permits_resource("repo:acme-private/catalog"));
        // The wildcard needs something after the separator.
        assert!(!g.permits_resource("repo:acme/"));

        g.resources = vec!["*".into()];
        assert!(g.permits_resource("anything"));

        // A grant that names no resources covers none.
        g.resources = vec![];
        assert!(!g.permits_resource("repo:acme/catalog"));
    }

    #[test]
    fn export_denied_by_default_invariant() {
        let g = sample_parent();
        assert!(!g.constraints.raw_credential_export);
    }
}

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

    #[kani::proof]
    fn wildcard_does_not_cross_separator() {
        assert!(resource_pattern_matches("repo:acme/*", "repo:acme/catalog"));
        assert!(!resource_pattern_matches(
            "repo:acme/*",
            "repo:acme-private/catalog"
        ));
        assert!(!resource_pattern_matches("repo:acme:*", "repo:acme-extra"));
    }
}
