//! Named roles, which are bundles of entries and nothing more.
//!
//! A role is the shape most authorization systems use to lose correlation a
//! second time. "Reader" and "Writer" get defined as action lists, a subject
//! is given both plus a resource list, and the product is back. So a role here
//! carries whole [`PermissionEntry`] values — actions *with* their resources —
//! and expanding several roles concatenates their entries without ever merging
//! two entries into one.
//!
//! Roles are also flat: a role cannot name another role. Inheritance would put
//! authority one indirection away from the definition a person reads, and a
//! cycle or a re-pointed parent would widen a grant without editing it.

use crate::permission::entry::PermissionEntry;
use crate::permission::set::{PermissionSet, MAX_SET_ENTRIES};
use crate::DomainError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Longest role name accepted.
pub const MAX_ROLE_NAME_LENGTH: usize = 64;
/// Most roles one catalog may define.
pub const MAX_CATALOG_ROLES: usize = 256;

/// A named bundle of correlated entries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRole {
    name: String,
    entries: Vec<PermissionEntry>,
}

impl PermissionRole {
    /// Define a role.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionEntryInvalid`] for an empty, oversized
    /// or non-bare name, for a name carrying a selector wildcard (a role name
    /// is an identifier, never a pattern), or for an empty entry list.
    pub fn new(name: &str, entries: Vec<PermissionEntry>) -> Result<Self, DomainError> {
        let invalid =
            |why: &str| DomainError::PermissionEntryInvalid(format!("role {name:?}: {why}"));
        if name.is_empty() {
            return Err(invalid("has no name"));
        }
        if name.len() > MAX_ROLE_NAME_LENGTH {
            return Err(invalid("name is too long"));
        }
        if name.trim() != name || name.chars().any(char::is_control) {
            return Err(invalid("name is not a bare identifier"));
        }
        if name.contains('*') {
            return Err(invalid(
                "name carries a wildcard; a role name is not a pattern",
            ));
        }
        if entries.is_empty() {
            return Err(invalid("grants nothing"));
        }
        if entries.len() > MAX_SET_ENTRIES {
            return Err(invalid("holds more entries than a permission set may"));
        }
        Ok(Self {
            name: name.to_string(),
            entries,
        })
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn entries(&self) -> &[PermissionEntry] {
        &self.entries
    }
}

/// The roles a deployment has defined.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleCatalog {
    roles: BTreeMap<String, PermissionRole>,
}

impl RoleCatalog {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a role.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionEntryInvalid`] when the name is
    /// already defined or the catalog is full. Redefinition is refused rather
    /// than overwritten: a role silently regaining authority is how a grant
    /// nobody edited starts permitting something new.
    pub fn define(&mut self, role: PermissionRole) -> Result<(), DomainError> {
        if self.roles.len() >= MAX_CATALOG_ROLES {
            return Err(DomainError::PermissionEntryInvalid(
                "role catalog is full".into(),
            ));
        }
        if self.roles.contains_key(role.name()) {
            return Err(DomainError::PermissionEntryInvalid(format!(
                "role {:?} is already defined; roles are replaced by a new definition, never redefined in place",
                role.name()
            )));
        }
        self.roles.insert(role.name().to_string(), role);
        Ok(())
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&PermissionRole> {
        self.roles.get(name)
    }

    #[must_use]
    pub fn names(&self) -> Vec<&str> {
        self.roles.keys().map(String::as_str).collect()
    }

    /// Expand role names into one permission set.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::PermissionRoleUnknown`] for a name this catalog
    /// does not define — fail closed, because skipping an unknown name would
    /// quietly hand out a different authority than the one requested, and
    /// [`DomainError::PermissionEntryInvalid`] if the union is over bounds.
    pub fn expand<N: AsRef<str>>(&self, names: &[N]) -> Result<PermissionSet, DomainError> {
        let mut entries: Vec<PermissionEntry> = Vec::new();
        for name in names {
            let name = name.as_ref();
            let role = self
                .roles
                .get(name)
                .ok_or_else(|| DomainError::PermissionRoleUnknown(name.to_string()))?;
            // Concatenate. Merging two roles' entries — union the actions,
            // union the resources — is precisely the cross product this type
            // exists to refuse.
            entries.extend(role.entries().iter().cloned());
        }
        PermissionSet::new(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> RoleCatalog {
        let mut catalog = RoleCatalog::new();
        catalog
            .define(
                PermissionRole::new(
                    "catalog-reader",
                    vec![PermissionEntry::new(&["read"], &["repo:acme/catalog"]).unwrap()],
                )
                .unwrap(),
            )
            .unwrap();
        catalog
            .define(
                PermissionRole::new(
                    "docs-writer",
                    vec![PermissionEntry::new(&["write"], &["repo:acme/docs"]).unwrap()],
                )
                .unwrap(),
            )
            .unwrap();
        catalog
    }

    #[test]
    fn holding_two_roles_does_not_cross_them() {
        let set = catalog()
            .expand(&["catalog-reader", "docs-writer"])
            .unwrap();
        assert!(set.permits("read", "repo:acme/catalog"));
        assert!(set.permits("write", "repo:acme/docs"));
        assert!(!set.permits("write", "repo:acme/catalog"));
        assert!(!set.permits("read", "repo:acme/docs"));
        assert_eq!(set.entries().len(), 2);
    }

    #[test]
    fn expansion_order_does_not_change_the_authority() {
        let forward = catalog()
            .expand(&["catalog-reader", "docs-writer"])
            .unwrap();
        let backward = catalog()
            .expand(&["docs-writer", "catalog-reader"])
            .unwrap();
        assert_eq!(forward, backward);
    }

    #[test]
    fn an_unknown_role_fails_closed() {
        let error = catalog().expand(&["catalog-reader", "admin"]).unwrap_err();
        assert!(
            matches!(&error, DomainError::PermissionRoleUnknown(name) if name == "admin"),
            "{error}"
        );
    }

    #[test]
    fn a_role_cannot_be_redefined_in_place() {
        let mut catalog = catalog();
        let wider = PermissionRole::new(
            "catalog-reader",
            vec![PermissionEntry::new(&["read", "write"], &["repo:acme/*"]).unwrap()],
        )
        .unwrap();
        assert!(catalog.define(wider).is_err());
        let set = catalog.expand(&["catalog-reader"]).unwrap();
        assert!(!set.permits("write", "repo:acme/catalog"));
    }

    #[test]
    fn role_names_are_identifiers_not_patterns() {
        let entries = vec![PermissionEntry::new(&["read"], &["repo:acme/catalog"]).unwrap()];
        assert!(PermissionRole::new("", entries.clone()).is_err());
        assert!(PermissionRole::new("reader*", entries.clone()).is_err());
        assert!(PermissionRole::new(" reader", entries.clone()).is_err());
        assert!(PermissionRole::new("reader", vec![]).is_err());
        assert!(PermissionRole::new("reader", entries).is_ok());
    }

    #[test]
    fn an_expanded_role_attenuates_against_itself_and_not_past_it() {
        let catalog = catalog();
        let both = catalog.expand(&["catalog-reader", "docs-writer"]).unwrap();
        let one = catalog.expand(&["catalog-reader"]).unwrap();
        assert!(one.attenuates(&both));
        assert!(!both.attenuates(&one));
    }
}
