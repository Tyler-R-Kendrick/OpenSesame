//! A set of permission entries, and the two directions between it and the
//! legacy flat `actions` / `resources` pair.
//!
//! **Flat to correlated** is total and needs no guessing. Two flat lists mean
//! the full cross product — that is what the two independent checks enforced —
//! so [`PermissionSet::from_flat`] produces exactly one entry holding both
//! lists. It does not try to infer which pairs the issuer "really" wanted;
//! there is no information in the flat form to infer it from, and inventing a
//! pairing would silently narrow a grant somebody is relying on.
//!
//! **Correlated to flat** is partial, and that is the point. Unioning
//! `(read, A)` and `(write, B)` into `actions: [read, write]`,
//! `resources: [A, B]` hands out `write A`, which nobody granted.
//! [`PermissionSet::flatten_lossless`] refuses instead, naming the pair that
//! would have been gained, and [`PermissionSet::split_flat`] offers the honest
//! alternative: one flat record per entry.

use crate::permission::entry::PermissionEntry;
use crate::permission::scope::ResourceScope;
use crate::{canonicalize_json, digest_sha256, DomainError};
use serde::{Deserialize, Serialize};

/// Most entries one set may hold.
pub const MAX_SET_ENTRIES: usize = 64;

/// An ordered, canonical set of correlated permission entries.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<PermissionEntry>", into = "Vec<PermissionEntry>")]
pub struct PermissionSet {
    entries: Vec<PermissionEntry>,
}

impl PermissionSet {
    /// An empty set. Authorizes nothing, and says nothing about what a
    /// legacy flat grant carries — see [`Self::from_flat`] for that.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// Build a set from entries.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionEntryInvalid`] when there are more
    /// than [`MAX_SET_ENTRIES`] entries.
    pub fn new(entries: Vec<PermissionEntry>) -> Result<Self, DomainError> {
        if entries.len() > MAX_SET_ENTRIES {
            return Err(DomainError::PermissionEntryInvalid(format!(
                "{} entries, over the {MAX_SET_ENTRIES} bound",
                entries.len()
            )));
        }
        let mut entries = entries;
        entries.sort_by(|a, b| {
            a.actions()
                .cmp(b.actions())
                .then_with(|| a.resource_patterns().cmp(&b.resource_patterns()))
        });
        entries.dedup();
        Ok(Self { entries })
    }

    /// The faithful reading of a legacy flat grant: one entry, both lists.
    ///
    /// # Errors
    ///
    /// Propagates [`PermissionEntry::new`]. An empty action or resource list
    /// is refused here too: callers that mean "nothing" should say
    /// [`Self::empty`] rather than lean on a validation failure.
    pub fn from_flat<A: AsRef<str>, R: AsRef<str>>(
        actions: &[A],
        resources: &[R],
    ) -> Result<Self, DomainError> {
        Ok(Self {
            entries: vec![PermissionEntry::new(actions, resources)?],
        })
    }

    #[must_use]
    pub fn entries(&self) -> &[PermissionEntry] {
        &self.entries
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// True when some single entry authorizes `action` on `resource`.
    #[must_use]
    pub fn permits(&self, action: &str, resource: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.permits(action, resource))
    }

    /// True when every pair this set authorizes is authorized by `parent`.
    ///
    /// Each child entry must be contained by one parent entry. A child that
    /// needed two parent entries to justify itself is claiming a pair that
    /// exists in neither, which is exactly the recombination attenuation has
    /// to refuse.
    #[must_use]
    pub fn attenuates(&self, parent: &Self) -> bool {
        self.entries
            .iter()
            .all(|child| parent.entries.iter().any(|entry| entry.contains(child)))
    }

    /// Every action any entry names, deduplicated. A *projection*, not a
    /// representation: on its own it authorizes more than the set does.
    #[must_use]
    pub fn projected_actions(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .entries
            .iter()
            .flat_map(|entry| entry.actions().iter().cloned())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Every selector any entry names, deduplicated. Same caveat.
    #[must_use]
    pub fn projected_scopes(&self) -> Vec<ResourceScope> {
        let mut out: Vec<ResourceScope> = self
            .entries
            .iter()
            .flat_map(|entry| entry.scopes().iter().cloned())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// The flat `(actions, resources)` pair — only when it means the same thing.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionCorrelationLost`] naming the first
    /// pair the flat form would authorize and this set does not. That error is
    /// the guard on every write into a two-list authority record: a caller
    /// holding correlated authority either flattens losslessly or stops.
    pub fn flatten_lossless(&self) -> Result<(Vec<String>, Vec<String>), DomainError> {
        let actions = self.projected_actions();
        let scopes = self.projected_scopes();
        let product = actions
            .iter()
            .flat_map(|action| scopes.iter().map(move |scope| (action, scope)));
        for (action, scope) in product {
            if !self.covers_selector(action, scope) {
                return Err(DomainError::PermissionCorrelationLost(format!(
                    "{action} on {scope}"
                )));
            }
        }
        Ok((actions, scopes.iter().map(ResourceScope::encode).collect()))
    }

    /// True when one entry names `action` and covers the whole of `scope`.
    ///
    /// Selector containment rather than resource matching, because the
    /// flattening check compares a projected *selector* against the entries it
    /// came from, not a concrete resource against a grant.
    #[must_use]
    fn covers_selector(&self, action: &str, scope: &ResourceScope) -> bool {
        self.entries.iter().any(|entry| {
            entry.permits_action(action) && entry.scopes().iter().any(|mine| mine.contains(scope))
        })
    }

    /// One flat `(actions, resources)` pair per entry.
    ///
    /// The honest way to put correlated authority into a store that only has
    /// two columns: one record per entry, kept separate, rather than one
    /// record that says more than any entry did.
    #[must_use]
    pub fn split_flat(&self) -> Vec<(Vec<String>, Vec<String>)> {
        self.entries
            .iter()
            .map(|entry| (entry.actions().to_vec(), entry.resource_patterns()))
            .collect()
    }

    /// Canonical digest of the whole set, for binding an approval to the
    /// authority it approved.
    ///
    /// # Errors
    ///
    /// Propagates [`DomainError::Canonicalization`].
    pub fn digest(&self) -> Result<String, DomainError> {
        let value = serde_json::to_value(self)
            .map_err(|error| DomainError::Canonicalization(error.to_string()))?;
        Ok(digest_sha256(&canonicalize_json(&value)?))
    }
}

impl TryFrom<Vec<PermissionEntry>> for PermissionSet {
    type Error = DomainError;

    fn try_from(entries: Vec<PermissionEntry>) -> Result<Self, Self::Error> {
        Self::new(entries)
    }
}

impl From<PermissionSet> for Vec<PermissionEntry> {
    fn from(set: PermissionSet) -> Self {
        set.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_a_write_b() -> PermissionSet {
        PermissionSet::new(vec![
            PermissionEntry::new(&["read"], &["repo:acme/a"]).unwrap(),
            PermissionEntry::new(&["write"], &["repo:acme/b"]).unwrap(),
        ])
        .unwrap()
    }

    #[test]
    fn read_a_and_write_b_never_become_write_a() {
        let set = read_a_write_b();
        assert!(set.permits("read", "repo:acme/a"));
        assert!(set.permits("write", "repo:acme/b"));
        assert!(!set.permits("write", "repo:acme/a"));
        assert!(!set.permits("read", "repo:acme/b"));
    }

    #[test]
    fn flat_input_is_the_product_it_always_was() {
        let set =
            PermissionSet::from_flat(&["read", "write"], &["repo:acme/a", "repo:acme/b"]).unwrap();
        assert_eq!(set.entries().len(), 1);
        assert!(set.permits("write", "repo:acme/a"));
        // Which is also why the correlated form cannot be recovered from it.
        assert_ne!(set, read_a_write_b());
    }

    #[test]
    fn flattening_a_correlated_set_is_refused_by_name() {
        let error = read_a_write_b().flatten_lossless().unwrap_err();
        assert!(
            matches!(&error, DomainError::PermissionCorrelationLost(pair) if pair.contains("repo:acme/")),
            "{error}"
        );
    }

    #[test]
    fn flattening_succeeds_when_it_changes_nothing() {
        let one = PermissionSet::from_flat(&["read", "write"], &["repo:acme/a"]).unwrap();
        let (actions, resources) = one.flatten_lossless().unwrap();
        assert_eq!(actions, ["read", "write"]);
        assert_eq!(resources, ["repo:acme/a"]);

        // Two entries that happen to tile the whole product flatten too.
        let tiled = PermissionSet::new(vec![
            PermissionEntry::new(&["read"], &["repo:acme/a", "repo:acme/b"]).unwrap(),
            PermissionEntry::new(&["write"], &["repo:acme/a", "repo:acme/b"]).unwrap(),
        ])
        .unwrap();
        assert!(tiled.flatten_lossless().is_ok());
    }

    #[test]
    fn splitting_keeps_each_entry_on_its_own() {
        let split = read_a_write_b().split_flat();
        assert_eq!(
            split,
            vec![
                (vec!["read".to_string()], vec!["repo:acme/a".to_string()]),
                (vec!["write".to_string()], vec!["repo:acme/b".to_string()]),
            ]
        );
    }

    #[test]
    fn attenuation_refuses_cross_entry_recombination() {
        let parent = read_a_write_b();
        let legit = PermissionSet::new(vec![
            PermissionEntry::new(&["read"], &["repo:acme/a"]).unwrap()
        ])
        .unwrap();
        assert!(legit.attenuates(&parent));

        let recombined =
            PermissionSet::new(vec![
                PermissionEntry::new(&["write"], &["repo:acme/a"]).unwrap()
            ])
            .unwrap();
        assert!(!recombined.attenuates(&parent));

        // Nor by merging both parent entries into one child entry.
        let merged = PermissionSet::new(vec![PermissionEntry::new(
            &["read", "write"],
            &["repo:acme/a", "repo:acme/b"],
        )
        .unwrap()])
        .unwrap();
        assert!(!merged.attenuates(&parent));
    }

    #[test]
    fn subtree_parents_still_admit_exact_children() {
        let parent = PermissionSet::new(vec![
            PermissionEntry::new(&["read"], &["repo:acme/*"]).unwrap()
        ])
        .unwrap();
        let child = PermissionSet::new(vec![PermissionEntry::new(
            &["read"],
            &["repo:acme/catalog"],
        )
        .unwrap()])
        .unwrap();
        assert!(child.attenuates(&parent));
        assert!(!parent.attenuates(&child));
    }

    #[test]
    fn digest_is_order_independent_and_correlation_sensitive() {
        let forward = read_a_write_b();
        let backward = PermissionSet::new(vec![
            PermissionEntry::new(&["write"], &["repo:acme/b"]).unwrap(),
            PermissionEntry::new(&["read"], &["repo:acme/a"]).unwrap(),
        ])
        .unwrap();
        assert_eq!(forward.digest().unwrap(), backward.digest().unwrap());

        let flattened =
            PermissionSet::from_flat(&["read", "write"], &["repo:acme/a", "repo:acme/b"]).unwrap();
        assert_ne!(forward.digest().unwrap(), flattened.digest().unwrap());
    }

    #[test]
    fn an_empty_set_authorizes_nothing() {
        let set = PermissionSet::empty();
        assert!(set.is_empty());
        assert!(!set.permits("read", "repo:acme/a"));
        assert_eq!(set.flatten_lossless().unwrap(), (vec![], vec![]));
    }
}
