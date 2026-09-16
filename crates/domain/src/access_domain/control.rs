//! Who administers an access domain, and how control inherits down a subtree.
//!
//! Control is **not** data-plane permission. Holding [`DomainRole::Owner`] on a
//! domain lets a principal rearrange domains and issue beneath them; it does
//! not unwrap vault ciphertext or exercise a connection. Those remain a
//! Grant+Intent decision, so nothing here is a second authority model.
//!
//! Three rules shape the resolution in [`ControlIndex::effective_control`]:
//!
//! 1. **Inheritance flows down, never up.** A [`ControlScope::Subtree`]
//!    assignment reaches descendants; a [`ControlScope::DomainOnly`] one stays
//!    exactly where it was made. There is no scope that reaches a parent.
//! 2. **[`InheritanceMode::Isolated`] cuts the branch at itself.** An isolated
//!    domain does not read its parent's assignments, and neither does anything
//!    beneath it, because the walk from a descendant has to pass through the
//!    isolated node to get any higher.
//! 3. **Delegation never widens.** [`ControlIndex::insert_delegated`] refuses a
//!    role the delegator does not already cover, so no chain of delegations can
//!    manufacture a rung nobody held. That is the property the
//!    [`DomainError::AccessDomainControlWiden`] refusal exists to name.
//!
//! On top of those, a personal realm admits control for at most one principal.
//! ADR 0038 refuses membership on a personal project outright, and nesting
//! domains inside one must not become a quieter way to share: the moment a
//! second principal would gain control, [`ControlIndex::insert`] refuses with
//! [`DomainError::AccessDomainPersonalSharing`].

use super::forest::AccessDomainForest;
use crate::{AccessDomainId, DomainControlId, DomainError, PrincipalId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The three-rung ladder, mirroring the organization and project roles ADR 0038
/// already established rather than inventing a parallel vocabulary.
///
/// Declaration order *is* the ladder: `Ord` is derived from it, so
/// [`DomainRole::covers`] and the "strongest role wins" resolution both read
/// straight off the comparison instead of a hand-written table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainRole {
    Member,
    Admin,
    Owner,
}

impl DomainRole {
    /// Whether this rung is at least `other` — the check delegation uses.
    #[must_use]
    pub fn covers(self, other: Self) -> bool {
        self >= other
    }

    /// Whether this rung may rearrange domains and issue beneath them.
    ///
    /// A member holds a place in the estate, not authority over it.
    #[must_use]
    pub fn can_administer(self) -> bool {
        matches!(self, Self::Admin | Self::Owner)
    }

    /// Whether this rung may hand the domain itself to somebody else.
    #[must_use]
    pub fn can_transfer_ownership(self) -> bool {
        matches!(self, Self::Owner)
    }
}

/// How far an assignment reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlScope {
    /// This domain and nothing else.
    DomainOnly,
    /// This domain and everything beneath it, until an isolated domain.
    Subtree,
}

/// Whether a domain reads control from above it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InheritanceMode {
    /// Inherit subtree assignments from ancestors.
    Inherit,
    /// Read only what was granted here. The branch below inherits nothing from
    /// above this node either.
    Isolated,
}

/// One principal's recorded control on one domain.
///
/// `Copy`, and identified by its own [`DomainControlId`], so an assignment can
/// be handed around, compared, and revoked by id without a caller having to
/// reconstruct the tuple it was made from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlAssignment {
    pub id: DomainControlId,
    pub domain_id: AccessDomainId,
    pub principal_id: PrincipalId,
    pub role: DomainRole,
    pub scope: ControlScope,
}

/// The answer to "what does this principal hold *here*", after inheritance.
///
/// `source_domain_id` is the provenance, and it is the reason this is a struct
/// rather than a bare [`DomainRole`]: control that arrived by inheritance is
/// revoked at the domain it was granted on, so an operator shown an effective
/// role needs to be told where to go to remove it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectiveControl {
    pub principal_id: PrincipalId,
    /// The domain the question was asked about.
    pub domain_id: AccessDomainId,
    pub role: DomainRole,
    /// The domain the assignment actually lives on — equal to `domain_id` when
    /// the control was granted directly.
    pub source_domain_id: AccessDomainId,
}

/// Every control assignment in one realm's forest, keyed by assignment id.
///
/// Keyed by id rather than by domain so revocation is a single lookup and so
/// iteration order is stable: two indexes holding the same assignments resolve,
/// list and digest identically regardless of the order they were built in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ControlIndex {
    assignments: BTreeMap<DomainControlId, ControlAssignment>,
}

impl ControlIndex {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.assignments.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.assignments.is_empty()
    }

    /// Every assignment, in id order.
    pub fn assignments(&self) -> impl Iterator<Item = &ControlAssignment> {
        self.assignments.values()
    }

    /// The assignments recorded directly on `domain_id`.
    pub fn at(&self, domain_id: AccessDomainId) -> impl Iterator<Item = &ControlAssignment> + '_ {
        self.assignments
            .values()
            .filter(move |held| held.domain_id == domain_id)
    }

    /// Record an assignment.
    ///
    /// # Errors
    ///
    /// - [`DomainError::AccessDomainNotFound`] — the domain is not in `forest`,
    ///   which is also what keeps this index realm-bound: the forest refuses
    ///   foreign domains, so control cannot be recorded against one.
    /// - [`DomainError::AccessDomainConflict`] — the id is already recorded, or
    ///   this principal already holds control on this domain. One row per
    ///   principal per domain, so there is never a pair of rows whose combined
    ///   reading is stronger than either.
    /// - [`DomainError::AccessDomainPersonalSharing`] — a second principal would
    ///   gain control in a personal project.
    pub fn insert(
        &mut self,
        forest: &AccessDomainForest,
        assignment: ControlAssignment,
    ) -> Result<(), DomainError> {
        forest.require(assignment.domain_id)?;
        if self.assignments.contains_key(&assignment.id) {
            return Err(DomainError::AccessDomainConflict(format!(
                "control {} is already recorded",
                assignment.id
            )));
        }
        if self
            .at(assignment.domain_id)
            .any(|held| held.principal_id == assignment.principal_id)
        {
            return Err(DomainError::AccessDomainConflict(format!(
                "a principal already holds control on domain {}",
                assignment.domain_id
            )));
        }
        // Only a *second* principal is sharing. One person holding control on
        // several domains of their own estate is what a personal project is
        // for, so the refusal is keyed on the principal, not the row count.
        if self
            .assignments
            .values()
            .any(|held| held.principal_id != assignment.principal_id)
        {
            forest
                .realm()
                .assert_admits_sharing("a second controlling principal")?;
        }
        self.assignments.insert(assignment.id, assignment);
        Ok(())
    }

    /// Record an assignment made *by* `delegator`, refusing anything wider than
    /// what they hold.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainControlWiden`] when the delegator holds no
    /// control on the domain, holds a role that does not administer it, or
    /// would hand out a rung above their own. Then everything
    /// [`ControlIndex::insert`] refuses — notably the personal-realm rule, so
    /// delegation is not a way around it.
    pub fn insert_delegated(
        &mut self,
        forest: &AccessDomainForest,
        delegator: PrincipalId,
        assignment: ControlAssignment,
    ) -> Result<(), DomainError> {
        let held = self
            .effective_control(forest, assignment.domain_id, delegator)?
            .ok_or_else(|| {
                DomainError::AccessDomainControlWiden(format!(
                    "{delegator} holds no control on domain {}",
                    assignment.domain_id
                ))
            })?;
        if !held.role.can_administer() {
            return Err(DomainError::AccessDomainControlWiden(format!(
                "{:?} does not administer domain {}",
                held.role, assignment.domain_id
            )));
        }
        if !held.role.covers(assignment.role) {
            return Err(DomainError::AccessDomainControlWiden(format!(
                "cannot delegate {:?} while holding {:?}",
                assignment.role, held.role
            )));
        }
        self.insert(forest, assignment)
    }

    /// Revoke one assignment by id.
    pub fn remove(&mut self, id: DomainControlId) -> Option<ControlAssignment> {
        self.assignments.remove(&id)
    }

    /// The strongest role granted *directly* on one rung of a walk.
    ///
    /// `inherited` says whether the rung is an ancestor rather than the domain
    /// the question was asked about. Domain-only control does not travel, so it
    /// is dropped on every rung but the first.
    fn strongest_at(
        &self,
        domain_id: AccessDomainId,
        principal_id: PrincipalId,
        inherited: bool,
    ) -> Option<DomainRole> {
        self.at(domain_id)
            .filter(|held| held.principal_id == principal_id)
            .filter(|held| !inherited || held.scope == ControlScope::Subtree)
            .map(|held| held.role)
            .max()
    }

    /// The strongest role `principal_id` holds on `domain_id`, after
    /// inheritance, or `None` when they hold nothing there.
    ///
    /// The walk goes from the domain upward and stops at the first isolated
    /// node, having counted what was granted on it. That ordering is what makes
    /// [`InheritanceMode::Isolated`] cover the whole branch rather than only the
    /// node it is set on: a descendant's walk cannot reach past it.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when the domain is absent, and
    /// [`DomainError::AccessDomainCycle`] when the parent walk revisits a node.
    pub fn effective_control(
        &self,
        forest: &AccessDomainForest,
        domain_id: AccessDomainId,
        principal_id: PrincipalId,
    ) -> Result<Option<EffectiveControl>, DomainError> {
        forest.require(domain_id)?;
        let mut chain = vec![domain_id];
        chain.extend(forest.ancestors(domain_id)?);
        let mut best: Option<EffectiveControl> = None;
        for (rung, source_domain_id) in chain.into_iter().enumerate() {
            let stronger = self
                .strongest_at(source_domain_id, principal_id, rung > 0)
                .filter(|role| best.is_none_or(|previous| *role > previous.role));
            if let Some(role) = stronger {
                best = Some(EffectiveControl {
                    principal_id,
                    domain_id,
                    role,
                    source_domain_id,
                });
            }
            if forest.require(source_domain_id)?.inheritance() == InheritanceMode::Isolated {
                break;
            }
        }
        Ok(best)
    }

    /// The administering control `principal_id` holds on `domain_id`.
    ///
    /// # Errors
    ///
    /// [`DomainError::AuthorizationDenied`] when the principal holds nothing
    /// there or holds a role that does not administer it, plus anything
    /// [`ControlIndex::effective_control`] reports.
    pub fn assert_may_administer(
        &self,
        forest: &AccessDomainForest,
        domain_id: AccessDomainId,
        principal_id: PrincipalId,
    ) -> Result<EffectiveControl, DomainError> {
        let held = self
            .effective_control(forest, domain_id, principal_id)?
            .ok_or_else(|| {
                DomainError::AuthorizationDenied(format!(
                    "{principal_id} holds no control on domain {domain_id}"
                ))
            })?;
        if !held.role.can_administer() {
            return Err(DomainError::AuthorizationDenied(format!(
                "{:?} does not administer domain {domain_id}",
                held.role
            )));
        }
        Ok(held)
    }
}
