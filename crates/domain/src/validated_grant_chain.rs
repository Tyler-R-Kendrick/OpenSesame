//! In-process validated grant lineage (INV-ROOT, INV-ATTENUATE).
//!
//! A raw `parent_grant_id` on a deserialized [`Grant`] is not proof of a current,
//! unrevoked, attenuation-checked chain. Only values constructed through
//! [`ValidatedGrantChain::try_validate`] may establish delegated eligibility at
//! the policy fence. This type deliberately does **not** implement Serde so a
//! wire round-trip cannot recreate verified status.

use crate::{ConnectionId, DomainError, Grant, GrantId, OrganizationId};
use chrono::{DateTime, Utc};

/// Unforgeable (within this process) proof that a grant chain was validated.
#[derive(Clone, Debug)]
pub struct ValidatedGrantChain {
    /// Root first, leaf last.
    grants: Vec<Grant>,
    /// Generation observed at validation; callers may fence against later revokes.
    invalidation_generation: u64,
}

impl ValidatedGrantChain {
    /// Validate root→…→leaf: active windows, attenuation each hop, matching pointers.
    ///
    /// # Errors
    ///
    /// Returns a domain error when the chain is empty, revoked, out of window,
    /// cyclically linked, or fails attenuation.
    pub fn try_validate(
        grants_root_to_leaf: &[Grant],
        now: DateTime<Utc>,
        invalidation_generation: u64,
    ) -> Result<Self, DomainError> {
        if grants_root_to_leaf.is_empty() {
            return Err(DomainError::GrantAttenuation("empty grant chain".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for g in grants_root_to_leaf {
            if !seen.insert(g.id) {
                return Err(DomainError::DelegationChainCycle);
            }
            g.assert_active(now)?;
        }
        let root = &grants_root_to_leaf[0];
        if root.parent_grant_id.is_some() {
            return Err(DomainError::GrantAttenuation(
                "chain root must not name a parent".into(),
            ));
        }
        if root.delegation_depth != 0 {
            return Err(DomainError::GrantAttenuation(
                "chain root delegation_depth must be 0".into(),
            ));
        }
        for window in grants_root_to_leaf.windows(2) {
            let parent = &window[0];
            let child = &window[1];
            Grant::validate_attenuation(parent, child)?;
        }
        Ok(Self {
            grants: grants_root_to_leaf.to_vec(),
            invalidation_generation,
        })
    }

    #[must_use]
    pub fn leaf(&self) -> &Grant {
        // SAFETY: try_validate rejects empty chains.
        self.grants.last().expect("non-empty chain")
    }

    #[must_use]
    pub fn root(&self) -> &Grant {
        // SAFETY: try_validate rejects empty chains.
        self.grants.first().expect("non-empty chain")
    }

    #[must_use]
    pub fn grants(&self) -> &[Grant] {
        &self.grants
    }

    #[must_use]
    pub fn root_id(&self) -> GrantId {
        self.root().id
    }

    #[must_use]
    pub fn leaf_id(&self) -> GrantId {
        self.leaf().id
    }

    #[must_use]
    pub fn organization_id(&self) -> OrganizationId {
        self.leaf().organization_id
    }

    #[must_use]
    pub fn connection_id(&self) -> Option<ConnectionId> {
        self.leaf().connection_id
    }

    /// Grant ids root→leaf for receipt / audit binding (GA-H-04).
    #[must_use]
    pub fn grant_ids(&self) -> Vec<GrantId> {
        self.grants.iter().map(|g| g.id).collect()
    }

    #[must_use]
    pub fn invalidation_generation(&self) -> u64 {
        self.invalidation_generation
    }

    /// True when this chain is a non-root delegation that may replace a tuple.
    #[must_use]
    pub fn establishes_delegated_eligibility(&self) -> bool {
        self.grants.len() >= 2 && self.leaf().parent_grant_id.is_some()
    }

    /// Re-check the leaf is still the grant the caller presented.
    #[must_use]
    pub fn binds_grant(&self, grant: &Grant) -> bool {
        self.leaf().id == grant.id
            && self.leaf().version == grant.version
            && self.leaf().organization_id == grant.organization_id
    }
}

/// Delegation chain a signed invocation receipt must name (GA-H-04).
///
/// With verified lineage, every hop is listed root→leaf. Without lineage
/// (root/owner exercise), the exercising grant alone is bound — never an empty
/// chain that would let a receipt float free of the authority that admitted it.
#[must_use]
pub fn receipt_delegation_chain(
    grant: &Grant,
    lineage: Option<&ValidatedGrantChain>,
) -> Vec<GrantId> {
    match lineage {
        Some(chain) => chain.grant_ids(),
        None => vec![grant.id],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ConnectionId, GrantConstraints, OfflineUse, OrganizationId, PrincipalId, ProjectId,
    };
    use chrono::Duration;

    fn sample(depth: u32, parent: Option<GrantId>, org: OrganizationId) -> Grant {
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
            organization_id: org,
            project_id: Some(ProjectId::new()),
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: vec!["repository.read".into()],
            resources: vec!["repo:acme/catalog".into()],
            constraints: GrantConstraints {
                audiences: vec!["https://api.example".into()],
                not_before: None,
                expires_at: now + Duration::hours(1),
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: [("calls".into(), 10 - i64::from(depth))]
                    .into_iter()
                    .collect(),
                maximum_delegation_depth: 2,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: false,
            },
            parent_grant_id: parent,
            delegation_depth: depth,
            created_at: now,
            revoked_at: None,
        }
    }

    #[test]
    fn raw_parent_pointer_alone_is_not_a_validated_chain() {
        let org = OrganizationId::new();
        let mut root = sample(0, None, org);
        root.constraints.budgets.insert("calls".into(), 10);
        let mut child = sample(1, Some(root.id), org);
        child.issuer_principal_id = root.beneficiary_principal_id;
        child.connection_id = root.connection_id;
        child.project_id = root.project_id;
        child.constraints.budgets.insert("calls".into(), 5);
        child.constraints.maximum_delegation_depth = 0;
        child.constraints.expires_at = root.constraints.expires_at - Duration::minutes(1);
        // Forged sibling with arbitrary parent id is rejected by try_validate
        // when attenuation/parent id do not match a real parent in the slice.
        let forged_parent = GrantId::new();
        let mut forged = child.clone();
        forged.parent_grant_id = Some(forged_parent);
        assert!(ValidatedGrantChain::try_validate(&[root.clone(), forged], Utc::now(), 0).is_err());
        assert!(ValidatedGrantChain::try_validate(&[root, child], Utc::now(), 0).is_ok());
    }

    #[test]
    fn receipt_chain_binds_grant_or_lineage() {
        let org = OrganizationId::new();
        let root = sample(0, None, org);
        let alone = receipt_delegation_chain(&root, None);
        assert_eq!(alone, vec![root.id]);

        let mut child = sample(1, Some(root.id), org);
        child.issuer_principal_id = root.beneficiary_principal_id;
        child.connection_id = root.connection_id;
        child.project_id = root.project_id;
        child.constraints.budgets.insert("calls".into(), 5);
        child.constraints.maximum_delegation_depth = 0;
        child.constraints.expires_at = root.constraints.expires_at - Duration::minutes(1);
        let chain =
            ValidatedGrantChain::try_validate(&[root.clone(), child.clone()], Utc::now(), 0)
                .expect("valid");
        assert_eq!(
            receipt_delegation_chain(&child, Some(&chain)),
            vec![root.id, child.id]
        );
    }
}
