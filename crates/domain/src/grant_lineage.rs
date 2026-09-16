//! Who may mint a child grant, and which bindings the child may still name.
//!
//! [`Grant::validate_attenuation`] compares the *authority* two grants carry. On
//! its own that says nothing about whether the child is a delegation of that
//! parent at all: `parent_grant_id` is a pointer anyone holding the parent's id
//! can copy, and every fence the parent names — project, environment,
//! connection, agent identity, proof key — is one a child could quietly point
//! somewhere else while every action, resource and budget still looks like a
//! subset. The checks here authenticate the *issuance*; the ones in
//! [`crate::grant_attenuation`] measure the shape of the authority.

use crate::{DomainError, Grant};
use std::collections::BTreeMap;

/// Everything an issuance must prove beyond attenuation.
///
/// # Errors
///
/// Returns [`DomainError::GrantAttenuation`] when the child was not minted by a
/// principal entitled to mint it, when it drops or transfers the parent's proof
/// key, or when it moves outside one of the parent's scope bindings.
pub fn validate_issuance(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
    validate_delegator(parent, child)?;
    validate_proof_key_transfer(parent, child)?;
    validate_scope_containment(parent, child)?;
    Ok(())
}

/// Exactly two principals may mint a child of `parent`.
///
/// The parent's **beneficiary** may delegate the authority it holds onward, and
/// the parent's **issuer** may re-issue a narrower grant on the holder's behalf
/// (how the Host mints a child against a synthesized owner ceiling). A third
/// principal naming the parent has authenticated nothing: it has copied a
/// pointer.
///
/// Timestamps are deliberately not part of this: `created_at` is a field the
/// minter writes, and an ancestor's record can legitimately be materialized
/// after the authority it stands for (the Host synthesizes a connection's owner
/// ceiling on first delegation), so a child "predating" its parent is a clock
/// artifact rather than evidence of anything.
///
/// # Errors
///
/// Returns [`DomainError::GrantAttenuation`] when the issuer is a stranger to
/// the parent.
pub fn validate_delegator(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
    let holder_delegates = child.issuer_principal_id == parent.beneficiary_principal_id;
    let issuer_reissues = child.issuer_principal_id == parent.issuer_principal_id;
    if !holder_delegates && !issuer_reissues {
        return Err(DomainError::GrantAttenuation(
            "child issuer is neither the parent's holder nor the parent's issuer".into(),
        ));
    }
    Ok(())
}

/// A proof-of-possession binding may be added or re-keyed, never dropped or
/// handed to somebody else.
///
/// Where the parent is key-bound, an unbound child is a downgrade to a bearer
/// grant — the strongest fence on the parent, removed by delegating. Reusing the
/// parent's own thumbprint for a different beneficiary is the other half of the
/// same move: the key proves the parent's holder, so a child that keeps the key
/// and changes the holder claims possession nobody demonstrated.
///
/// # Errors
///
/// Returns [`DomainError::GrantAttenuation`] on a dropped binding or a
/// transferred key.
pub fn validate_proof_key_transfer(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
    match (&parent.proof_key_thumbprint, &child.proof_key_thumbprint) {
        (Some(_), None) => Err(DomainError::GrantAttenuation(
            "proof-of-possession binding dropped by the child".into(),
        )),
        (Some(parent_key), Some(child_key))
            if parent_key == child_key
                && child.beneficiary_principal_id != parent.beneficiary_principal_id =>
        {
            Err(DomainError::GrantAttenuation(
                "parent proof key reused for a different beneficiary".into(),
            ))
        }
        _ => Ok(()),
    }
}

/// Scope bindings narrow or stay put; they never move sideways.
///
/// A grant scoped to one project, environment, connection, agent or agent
/// instance is exercisable only there. A child that names a *different* one has
/// authority the parent never held, and a child that drops the binding has
/// escaped the fence into everything the organization owns — both are widening,
/// however the actions and resources compare. An unbound parent may be narrowed
/// by a child that binds.
///
/// # Errors
///
/// Returns [`DomainError::GrantAttenuation`] naming the binding that moved.
pub fn validate_scope_containment(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
    let bindings = [
        (
            "project",
            binding_narrows(parent.project_id, child.project_id),
        ),
        (
            "environment",
            binding_narrows(parent.environment_id, child.environment_id),
        ),
        (
            "connection",
            binding_narrows(parent.connection_id, child.connection_id),
        ),
        ("actor", binding_narrows(parent.actor_id, child.actor_id)),
        ("client", binding_narrows(parent.client_id, child.client_id)),
        (
            "actor_instance",
            binding_narrows(parent.actor_instance_id, child.actor_instance_id),
        ),
    ];
    for (binding, narrows) in bindings {
        if !narrows {
            return Err(DomainError::GrantAttenuation(format!(
                "{binding} binding widened or moved"
            )));
        }
    }
    Ok(())
}

/// `None` on the parent is "unbound", so any child value narrows it. A bound
/// parent admits only the same value: neither a different one nor `None`.
fn binding_narrows<T: PartialEq>(parent: Option<T>, child: Option<T>) -> bool {
    match (parent, child) {
        (None, _) => true,
        (Some(parent_value), Some(child_value)) => parent_value == child_value,
        (Some(_), None) => false,
    }
}

impl crate::ValidatedGrantChain {
    /// The budget ceiling the whole lineage leaves standing, key by key.
    ///
    /// Enforcement reads a budget off one grant, so a hop that simply stops
    /// naming a metered key would read as "not metered". Attenuation refuses
    /// that hop outright; this fold is the second answer, and it is the value
    /// a meter should spend against: the smallest limit any ancestor set.
    #[must_use]
    pub fn effective_budgets(&self) -> BTreeMap<String, i64> {
        let mut ceilings: BTreeMap<String, i64> = BTreeMap::new();
        for grant in self.grants() {
            for (key, value) in &grant.constraints.budgets {
                ceilings
                    .entry(key.clone())
                    .and_modify(|held| *held = (*held).min(*value))
                    .or_insert(*value);
            }
        }
        ceilings
    }

    /// The leaf, but only when this chain really is a delegation.
    ///
    /// A policy fence that wants to accept delegated authority in place of the
    /// owner's own relationship tuple needs both halves: a validated chain, and
    /// a leaf that is genuinely a child of something. Asking the leaf whether
    /// `parent_grant_id.is_some()` answers only the second, and answers it from
    /// a field the leaf carries about itself.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::GrantAttenuation`] when the chain is a bare root.
    pub fn require_delegated_leaf(&self) -> Result<&Grant, DomainError> {
        if !self.establishes_delegated_eligibility() {
            return Err(DomainError::GrantAttenuation(
                "chain is a root grant, not a delegation".into(),
            ));
        }
        Ok(self.leaf())
    }
}
