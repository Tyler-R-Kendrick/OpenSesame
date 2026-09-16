//! Mutations: create, rename, reparent, retire, prune.
//!
//! Every one of them lands through [`super::forest::AccessDomainForest::insert`]
//! or re-runs the same checks, so there is no "fast path" that edits an edge
//! without proving the result is still a realm-bound acyclic forest.
//!
//! The mutation that does not exist is the important one. Nothing here moves a
//! domain to another realm: [`AccessDomainForest::reparent`] takes ids from one
//! forest, and a domain lifted out with
//! [`AccessDomainForest::remove_subtree`] can only re-enter through `insert`,
//! which refuses a foreign realm. So a domain's project — and with it the
//! `project_id` sealed into its vault's AEAD associated data (ADR 0038) — is
//! fixed for the domain's whole life.

use super::control::InheritanceMode;
use super::forest::{AccessDomainForest, MAX_DOMAIN_DEPTH};
use super::node::{assert_display_name, assert_slug, AccessDomain};
use super::temporal::DomainLifetime;
use crate::{AccessDomainId, DomainError};
use chrono::{DateTime, Utc};

impl AccessDomainForest {
    /// Create and insert a root domain.
    ///
    /// # Errors
    ///
    /// As [`AccessDomain::root`] and [`AccessDomainForest::insert`].
    pub fn create_root(
        &mut self,
        id: AccessDomainId,
        slug: &str,
        display_name: &str,
        created_at: DateTime<Utc>,
    ) -> Result<AccessDomainId, DomainError> {
        let domain = AccessDomain::root(id, self.realm(), slug, display_name, created_at)?;
        self.insert(domain)?;
        Ok(id)
    }

    /// Create and insert a child domain.
    ///
    /// # Errors
    ///
    /// As [`AccessDomain::child`] and [`AccessDomainForest::insert`].
    pub fn create_child(
        &mut self,
        id: AccessDomainId,
        parent_id: AccessDomainId,
        slug: &str,
        display_name: &str,
        created_at: DateTime<Utc>,
    ) -> Result<AccessDomainId, DomainError> {
        let domain =
            AccessDomain::child(id, self.realm(), parent_id, slug, display_name, created_at)?;
        self.insert(domain)?;
        Ok(id)
    }

    /// Change a domain's slug and human-facing name.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`], [`DomainError::AccessDomainInvalid`]
    /// for a malformed slug or name, and [`DomainError::AccessDomainConflict`]
    /// when a sibling already holds the slug.
    pub fn rename(
        &mut self,
        id: AccessDomainId,
        slug: &str,
        display_name: &str,
    ) -> Result<(), DomainError> {
        assert_slug(slug)?;
        assert_display_name(display_name)?;
        let parent_id = self.require(id)?.parent_id();
        self.assert_slug_free(parent_id, slug, Some(id))?;
        let node = self.node_mut(id)?;
        node.set_slug(slug.to_string());
        node.set_display_name(display_name.to_string());
        Ok(())
    }

    /// Break control inheritance at a domain, or restore it.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when the domain is absent.
    pub fn set_inheritance(
        &mut self,
        id: AccessDomainId,
        inheritance: InheritanceMode,
    ) -> Result<(), DomainError> {
        self.node_mut(id)?.set_inheritance(inheritance);
        Ok(())
    }

    /// Change a domain's lifetime.
    ///
    /// Direct children are enough to check: each of them already fits inside
    /// this domain's old lifetime, and "fits inside" is transitive, so a child
    /// that fits the new one carries its own descendants with it.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`], and
    /// [`DomainError::AccessDomainLifetime`] when the new lifetime is malformed,
    /// escapes the parent's deadline, or would outlive a child — the last case
    /// being how a subtree would otherwise be left dangling past its root.
    pub fn set_lifetime(
        &mut self,
        id: AccessDomainId,
        lifetime: DomainLifetime,
    ) -> Result<(), DomainError> {
        let domain = self.require(id)?;
        lifetime.assert_well_formed(domain.created_at())?;
        if let Some(parent_id) = domain.parent_id() {
            lifetime.assert_within(&self.require(parent_id)?.lifetime())?;
        }
        for child in self.children(id) {
            self.require(child)?.lifetime().assert_within(&lifetime)?;
        }
        self.node_mut(id)?.set_lifetime(lifetime);
        Ok(())
    }

    /// Move a domain to a new parent, or up to a root.
    ///
    /// # Errors
    ///
    /// - [`DomainError::AccessDomainNotFound`] — either id is absent.
    /// - [`DomainError::AccessDomainCycle`] — the new parent is the domain
    ///   itself or sits inside its subtree. This is the check that keeps the
    ///   forest a forest under movement.
    /// - [`DomainError::AccessDomainDepthExceeded`] — the moved subtree would
    ///   reach past [`MAX_DOMAIN_DEPTH`]. Measured with the subtree's whole
    ///   height, not just the moved node, so a deep branch cannot be smuggled
    ///   under a deep parent.
    /// - [`DomainError::AccessDomainConflict`] — a new sibling holds the slug.
    /// - [`DomainError::AccessDomainLifetime`] — a permanent domain would land
    ///   under a temporary one, or the move would let it outlive its parent.
    pub fn reparent(
        &mut self,
        id: AccessDomainId,
        new_parent: Option<AccessDomainId>,
    ) -> Result<(), DomainError> {
        let lifetime = self.require(id)?.lifetime();
        let slug = self.require(id)?.slug().to_string();
        if let Some(parent_id) = new_parent {
            if parent_id == id {
                return Err(DomainError::AccessDomainCycle(format!(
                    "{id} cannot be its own parent"
                )));
            }
            self.require(parent_id)?;
            if self.is_in_subtree_of(parent_id, id)? {
                return Err(DomainError::AccessDomainCycle(format!(
                    "{parent_id} is inside the subtree of {id}"
                )));
            }
            lifetime.assert_within(&self.require(parent_id)?.lifetime())?;
            let reach = self.depth(parent_id)? + self.subtree_height(id)?;
            if reach > MAX_DOMAIN_DEPTH {
                return Err(DomainError::AccessDomainDepthExceeded(reach));
            }
        }
        self.assert_slug_free(new_parent, &slug, Some(id))?;
        self.node_mut(id)?.set_parent(new_parent);
        Ok(())
    }

    /// Remove a domain that has no children.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when absent, and
    /// [`DomainError::AccessDomainConflict`] when it still has children —
    /// removing a parent by itself would leave them pointing at nothing, which
    /// is exactly the state every read here refuses to interpret.
    pub fn remove_leaf(&mut self, id: AccessDomainId) -> Result<AccessDomain, DomainError> {
        self.require(id)?;
        let children = self.children(id);
        if !children.is_empty() {
            return Err(DomainError::AccessDomainConflict(format!(
                "{id} still has {} child domains",
                children.len()
            )));
        }
        self.take(id)
            .ok_or_else(|| DomainError::AccessDomainNotFound(id.to_string()))
    }

    /// Remove a domain and everything beneath it, deepest first.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when `id` is absent, plus anything
    /// the subtree walk reports.
    pub fn remove_subtree(&mut self, id: AccessDomainId) -> Result<Vec<AccessDomain>, DomainError> {
        let mut members = self.subtree(id)?;
        // Deepest first, so the forest is a valid forest after every single
        // removal rather than only at the end.
        let mut keyed = Vec::with_capacity(members.len());
        for member in members.drain(..) {
            keyed.push((self.depth(member)?, member));
        }
        keyed.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        let mut removed = Vec::with_capacity(keyed.len());
        for (_, member) in keyed {
            if let Some(domain) = self.take(member) {
                removed.push(domain);
            }
        }
        Ok(removed)
    }

    /// Remove every expired domain, with its subtree.
    ///
    /// Safe to cascade precisely because a permanent domain can never sit under
    /// a temporary one: everything swept up here was itself on a clock.
    ///
    /// # Errors
    ///
    /// Anything the subtree walk reports — in a forest that passed
    /// [`AccessDomainForest::assert_acyclic`], nothing.
    pub fn prune_expired(&mut self, now: DateTime<Utc>) -> Result<Vec<AccessDomain>, DomainError> {
        let mut removed = Vec::new();
        for id in self.expired(now) {
            if !self.contains(id) {
                continue;
            }
            removed.append(&mut self.remove_subtree(id)?);
        }
        removed.sort_by_key(AccessDomain::id);
        Ok(removed)
    }
}
