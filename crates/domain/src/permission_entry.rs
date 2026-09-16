//! Correlated permission entries (INV-CORRELATE).
//!
//! Legacy grants store flat `actions[]` and `resources[]`. Interpreting those
//! lists as an independent Cartesian product would turn `(read, A)` +
//! `(write, B)` into `write A`. A [`PermissionEntry`] keeps one correlated
//! binding; a [`PermissionSet`] is an explicit list of such bindings.
//!
//! When migrating legacy flat lists whose historical execution path genuinely
//! meant the Cartesian product, call [`PermissionSet::cartesian_from_legacy`]
//! explicitly. Unknown historical intent must deny activation rather than guess.

use crate::DomainError;
use serde::{Deserialize, Serialize};

/// One correlated right: resource + operation/actions + optional parameter digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionEntry {
    pub resource_selector: String,
    /// Provider operation id when known (e.g. `http.request`, `repository.read`).
    pub provider_operation_id: Option<String>,
    pub action_set: Vec<String>,
    pub parameter_constraints_digest: Option<String>,
    pub audience_set: Vec<String>,
    pub manifest_digest: Option<String>,
}

impl PermissionEntry {
    /// True when this entry covers the requested action + resource (+ optional audience).
    #[must_use]
    pub fn covers(
        &self,
        action: &str,
        resource: &str,
        audience: Option<&str>,
        resource_matches: impl Fn(&str, &str) -> bool,
    ) -> bool {
        if !self.action_set.iter().any(|a| a == action) {
            return false;
        }
        if !resource_matches(&self.resource_selector, resource) {
            return false;
        }
        if let Some(aud) = audience {
            if !self.audience_set.is_empty() && !self.audience_set.iter().any(|a| a == aud) {
                return false;
            }
        }
        true
    }
}

/// Explicit list of correlated entries — never an implicit product of two lists.
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PermissionSet {
    pub entries: Vec<PermissionEntry>,
}

impl PermissionSet {
    /// Encode the Cartesian product of legacy flat lists **explicitly**.
    ///
    /// Empty action or resource lists yield an empty set (covers nothing).
    #[must_use]
    pub fn cartesian_from_legacy(
        actions: &[String],
        resources: &[String],
        audiences: &[String],
    ) -> Self {
        let mut entries = Vec::with_capacity(actions.len().saturating_mul(resources.len()));
        for action in actions {
            for resource in resources {
                entries.push(PermissionEntry {
                    resource_selector: resource.clone(),
                    provider_operation_id: Some(action.clone()),
                    action_set: vec![action.clone()],
                    parameter_constraints_digest: None,
                    audience_set: audiences.to_vec(),
                    manifest_digest: None,
                });
            }
        }
        Self { entries }
    }

    /// Prefer paired zip when lengths match; otherwise refuse — do not invent correlations.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::GrantAttenuation`] when lengths differ.
    pub fn try_from_legacy_paired(
        actions: &[String],
        resources: &[String],
        audiences: &[String],
    ) -> Result<Self, DomainError> {
        if actions.len() != resources.len() {
            return Err(DomainError::GrantAttenuation(
                "legacy action/resource lists have unequal length; refuse unpaired correlation"
                    .into(),
            ));
        }
        let entries = actions
            .iter()
            .zip(resources.iter())
            .map(|(action, resource)| PermissionEntry {
                resource_selector: resource.clone(),
                provider_operation_id: Some(action.clone()),
                action_set: vec![action.clone()],
                parameter_constraints_digest: None,
                audience_set: audiences.to_vec(),
                manifest_digest: None,
            })
            .collect();
        Ok(Self { entries })
    }

    /// True when any single entry covers the request (candidate-path independence).
    #[must_use]
    pub fn allows(
        &self,
        action: &str,
        resource: &str,
        audience: Option<&str>,
        resource_matches: impl Fn(&str, &str) -> bool,
    ) -> bool {
        self.entries
            .iter()
            .any(|e| e.covers(action, resource, audience, &resource_matches))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_pattern_matches;

    #[test]
    fn read_a_and_write_b_does_not_permit_write_a() {
        let set = PermissionSet {
            entries: vec![
                PermissionEntry {
                    resource_selector: "res:A".into(),
                    provider_operation_id: Some("read".into()),
                    action_set: vec!["read".into()],
                    parameter_constraints_digest: None,
                    audience_set: vec![],
                    manifest_digest: None,
                },
                PermissionEntry {
                    resource_selector: "res:B".into(),
                    provider_operation_id: Some("write".into()),
                    action_set: vec!["write".into()],
                    parameter_constraints_digest: None,
                    audience_set: vec![],
                    manifest_digest: None,
                },
            ],
        };
        assert!(set.allows("read", "res:A", None, resource_pattern_matches));
        assert!(set.allows("write", "res:B", None, resource_pattern_matches));
        assert!(!set.allows("write", "res:A", None, resource_pattern_matches));
        assert!(!set.allows("read", "res:B", None, resource_pattern_matches));
    }

    #[test]
    fn cartesian_legacy_is_explicit_product() {
        let set = PermissionSet::cartesian_from_legacy(
            &["read".into(), "write".into()],
            &["res:A".into(), "res:B".into()],
            &[],
        );
        assert_eq!(set.entries.len(), 4);
        assert!(set.allows("write", "res:A", None, resource_pattern_matches));
    }

    #[test]
    fn unequal_legacy_lists_refuse_paired_migration() {
        let err = PermissionSet::try_from_legacy_paired(
            &["read".into()],
            &["res:A".into(), "res:B".into()],
            &[],
        );
        assert!(err.is_err());
    }
}
