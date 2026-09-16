//! The forest: every domain in one realm, and the reads that walk it.
//!
//! [`AccessDomainForest::insert`] is the only way a node enters, and it is
//! where every structural invariant is checked. That single chokepoint is what
//! makes the acyclicity argument short enough to trust: a node arriving with a
//! fresh id and a parent that is *already in an acyclic forest* cannot close a
//! cycle, because nothing points at the new node yet. Reparenting is the only
//! other operation that can change an edge, and it carries its own subtree
//! check (see [`super::mutate`]).
//!
//! The reads never trust that argument blindly. [`AccessDomainForest::ancestors`]
//! walks with a visited set and reports [`DomainError::AccessDomainCycle`]
//! rather than looping, so a forest rehydrated from storage that somehow *is*
//! cyclic fails loudly on the first read instead of hanging a request.

use super::node::AccessDomain;
use super::realm::Realm;
use crate::{AccessDomainId, DomainError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// How deep a domain path may go, counting the root as level 1.
///
/// Eight is an estate a person can still read out loud: organization, division,
/// team, service, environment, and room to spare. Past that, a path stops being
/// an explanation of where authority lives and becomes something an operator
/// has to decode.
pub const MAX_DOMAIN_DEPTH: usize = 8;

/// Every access domain in one realm.
///
/// Ordered maps throughout: two forests holding the same domains iterate,
/// serialize and digest identically, so a listing does not depend on insertion
/// order and a caller cannot tell how a forest was assembled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessDomainForest {
    realm: Realm,
    nodes: BTreeMap<AccessDomainId, AccessDomain>,
}

impl AccessDomainForest {
    /// An empty forest for `realm`.
    #[must_use]
    pub fn new(realm: Realm) -> Self {
        Self {
            realm,
            nodes: BTreeMap::new(),
        }
    }

    /// The org/project boundary every node in this forest shares.
    #[must_use]
    pub fn realm(&self) -> Realm {
        self.realm
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    #[must_use]
    pub fn contains(&self, id: AccessDomainId) -> bool {
        self.nodes.contains_key(&id)
    }

    #[must_use]
    pub fn get(&self, id: AccessDomainId) -> Option<&AccessDomain> {
        self.nodes.get(&id)
    }

    /// Every domain, in id order.
    pub fn domains(&self) -> impl Iterator<Item = &AccessDomain> {
        self.nodes.values()
    }

    /// Look a domain up or say which one was missing.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when `id` is not in this forest.
    pub fn require(&self, id: AccessDomainId) -> Result<&AccessDomain, DomainError> {
        self.nodes
            .get(&id)
            .ok_or_else(|| DomainError::AccessDomainNotFound(id.to_string()))
    }

    /// Add a domain, checking every structural rule.
    ///
    /// # Errors
    ///
    /// - [`DomainError::AccessDomainRealmMismatch`] — the node belongs to
    ///   another org/project. This is the refusal that makes cross-realm
    ///   reparenting unreachable: a domain lifted out of one realm's forest can
    ///   never be admitted to another's.
    /// - [`DomainError::AccessDomainConflict`] — the id is already present, or
    ///   a sibling already holds the slug.
    /// - [`DomainError::AccessDomainNotFound`] — the named parent is not here.
    /// - [`DomainError::AccessDomainDepthExceeded`] — past [`MAX_DOMAIN_DEPTH`].
    /// - [`DomainError::AccessDomainLifetime`] — a permanent domain under a
    ///   temporary one, or a child that would outlive its parent.
    /// - [`DomainError::AccessDomainVaultBinding`] — a vault sealed against
    ///   another project.
    pub fn insert(&mut self, domain: AccessDomain) -> Result<(), DomainError> {
        self.realm.assert_same_boundary(&domain.realm())?;
        if self.contains(domain.id()) {
            return Err(DomainError::AccessDomainConflict(format!(
                "domain {} is already in this forest",
                domain.id()
            )));
        }
        if let Some(binding) = domain.vault_binding() {
            binding.assert_matches_realm(&self.realm)?;
        }
        if let Some(parent_id) = domain.parent_id() {
            let parent = self.require(parent_id)?;
            domain.lifetime().assert_within(&parent.lifetime())?;
            let depth = self.depth(parent_id)? + 1;
            if depth > MAX_DOMAIN_DEPTH {
                return Err(DomainError::AccessDomainDepthExceeded(depth));
            }
        }
        self.assert_slug_free(domain.parent_id(), domain.slug(), None)?;
        self.nodes.insert(domain.id(), domain);
        Ok(())
    }

    /// The forest's roots, in id order.
    #[must_use]
    pub fn roots(&self) -> Vec<AccessDomainId> {
        self.nodes
            .values()
            .filter(|domain| domain.is_root())
            .map(AccessDomain::id)
            .collect()
    }

    /// The direct children of `id`, in id order. Empty for a leaf, and for an
    /// id this forest does not hold.
    #[must_use]
    pub fn children(&self, id: AccessDomainId) -> Vec<AccessDomainId> {
        self.nodes
            .values()
            .filter(|domain| domain.parent_id() == Some(id))
            .map(AccessDomain::id)
            .collect()
    }

    /// The ancestors of `id`, nearest parent first, ending at a root.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when `id` or one of its parents is
    /// absent, and [`DomainError::AccessDomainCycle`] when the walk revisits a
    /// node — a shape `insert` and `reparent` refuse, checked again here so a
    /// corrupt rehydration cannot spin.
    pub fn ancestors(&self, id: AccessDomainId) -> Result<Vec<AccessDomainId>, DomainError> {
        let mut seen = BTreeSet::from([id]);
        let mut chain = Vec::new();
        let mut cursor = self.require(id)?.parent_id();
        while let Some(current) = cursor {
            if !seen.insert(current) {
                return Err(DomainError::AccessDomainCycle(format!(
                    "walk from {id} revisits {current}"
                )));
            }
            chain.push(current);
            cursor = self.require(current)?.parent_id();
        }
        Ok(chain)
    }

    /// How deep `id` sits, counting itself. A root is 1.
    ///
    /// # Errors
    ///
    /// As [`AccessDomainForest::ancestors`].
    pub fn depth(&self, id: AccessDomainId) -> Result<usize, DomainError> {
        Ok(self.ancestors(id)?.len() + 1)
    }

    /// The readable path to `id`, root slug first: `platform/prod`.
    ///
    /// # Errors
    ///
    /// As [`AccessDomainForest::ancestors`].
    pub fn path(&self, id: AccessDomainId) -> Result<String, DomainError> {
        let mut slugs = vec![self.require(id)?.slug()];
        for ancestor in self.ancestors(id)? {
            slugs.push(self.require(ancestor)?.slug());
        }
        slugs.reverse();
        Ok(slugs.join("/"))
    }

    /// `id` and everything beneath it, breadth first, siblings in id order.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainNotFound`] when `id` is absent.
    pub fn subtree(&self, id: AccessDomainId) -> Result<Vec<AccessDomainId>, DomainError> {
        self.require(id)?;
        let mut collected = vec![id];
        let mut frontier = vec![id];
        let mut seen = BTreeSet::from([id]);
        while let Some(current) = frontier.pop() {
            // A cycle would make this loop forever; `seen` turns it into a
            // finite (and wrong-looking) answer that `assert_acyclic` reports
            // properly.
            let unvisited = self
                .children(current)
                .into_iter()
                .filter(|child| seen.insert(*child));
            for child in unvisited {
                collected.push(child);
                frontier.push(child);
            }
        }
        Ok(collected)
    }

    /// Whether `id` is `ancestor` or sits beneath it.
    ///
    /// # Errors
    ///
    /// As [`AccessDomainForest::subtree`].
    pub fn is_in_subtree_of(
        &self,
        id: AccessDomainId,
        ancestor: AccessDomainId,
    ) -> Result<bool, DomainError> {
        Ok(self.subtree(ancestor)?.contains(&id))
    }

    /// How many levels the subtree rooted at `id` spans, `id` itself being 1.
    ///
    /// # Errors
    ///
    /// As [`AccessDomainForest::ancestors`].
    pub fn subtree_height(&self, id: AccessDomainId) -> Result<usize, DomainError> {
        let base = self.depth(id)?;
        let mut height = 1;
        for member in self.subtree(id)? {
            height = height.max(self.depth(member)? + 1 - base);
        }
        Ok(height)
    }

    /// Prove the whole forest is a forest.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainCycle`] when any node's parent walk revisits
    /// a node, [`DomainError::AccessDomainNotFound`] on a dangling parent,
    /// [`DomainError::AccessDomainDepthExceeded`] past [`MAX_DOMAIN_DEPTH`], and
    /// [`DomainError::AccessDomainRealmMismatch`] if a node from another realm
    /// ever got in.
    pub fn assert_acyclic(&self) -> Result<(), DomainError> {
        for domain in self.nodes.values() {
            self.realm.assert_same_boundary(&domain.realm())?;
            let depth = self.depth(domain.id())?;
            if depth > MAX_DOMAIN_DEPTH {
                return Err(DomainError::AccessDomainDepthExceeded(depth));
            }
        }
        Ok(())
    }

    /// Every deadline in the forest, earliest first.
    ///
    /// This is what the lifecycle scanner reads (ADR 0074). Ids and timestamps
    /// only — a deadline is metadata, and nothing here can carry a value.
    #[must_use]
    pub fn deadlines(&self) -> Vec<(AccessDomainId, DateTime<Utc>)> {
        let mut due: Vec<(AccessDomainId, DateTime<Utc>)> = self
            .nodes
            .values()
            .filter_map(|domain| domain.lifetime().deadline().map(|at| (domain.id(), at)))
            .collect();
        due.sort_by_key(|(id, at)| (*at, *id));
        due
    }

    /// The domains whose own deadline has passed at `now`.
    #[must_use]
    pub fn expired(&self, now: DateTime<Utc>) -> Vec<AccessDomainId> {
        self.nodes
            .values()
            .filter(|domain| domain.lifetime().is_expired(now))
            .map(AccessDomain::id)
            .collect()
    }

    /// Whether `id` can be reached at `now`: itself live, and every ancestor
    /// live too.
    ///
    /// An expired parent is not a cosmetic state. Its subtree is gone with it,
    /// so a still-dated child must not answer as reachable in the window before
    /// a pruner runs.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainExpired`] when this domain or any ancestor has
    /// passed its deadline, plus anything [`AccessDomainForest::ancestors`]
    /// reports.
    pub fn assert_reachable(
        &self,
        id: AccessDomainId,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        self.require(id)?.assert_active(now)?;
        for ancestor in self.ancestors(id)? {
            self.require(ancestor)?.assert_active(now)?;
        }
        Ok(())
    }

    /// Refuse a slug a sibling already holds.
    ///
    /// `except` is the node being renamed or moved, so it does not collide with
    /// itself.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainConflict`] on a taken slug.
    pub(super) fn assert_slug_free(
        &self,
        parent_id: Option<AccessDomainId>,
        slug: &str,
        except: Option<AccessDomainId>,
    ) -> Result<(), DomainError> {
        let taken = self.nodes.values().any(|domain| {
            domain.parent_id() == parent_id && domain.slug() == slug && Some(domain.id()) != except
        });
        if taken {
            return Err(DomainError::AccessDomainConflict(format!(
                "slug {slug:?} is already taken among these siblings"
            )));
        }
        Ok(())
    }

    pub(super) fn node_mut(
        &mut self,
        id: AccessDomainId,
    ) -> Result<&mut AccessDomain, DomainError> {
        self.nodes
            .get_mut(&id)
            .ok_or_else(|| DomainError::AccessDomainNotFound(id.to_string()))
    }

    pub(super) fn take(&mut self, id: AccessDomainId) -> Option<AccessDomain> {
        self.nodes.remove(&id)
    }
}
