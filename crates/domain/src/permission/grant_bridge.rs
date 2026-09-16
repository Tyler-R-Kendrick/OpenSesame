//! Reading a flat [`Grant`] as correlated authority, and the rule that keeps
//! a flat grant from ever carrying more than one entry's worth.
//!
//! A grant's `actions` and `resources` are two independent lists, and two
//! independent lists *are* a cross product — that is what the enforcement path
//! has always applied. So the reading is exact and needs no guessing:
//! [`Grant::permission_set`] returns one entry holding both lists.
//!
//! The load-bearing half is the other direction. [`issue_flat`] is how
//! correlated authority becomes flat grants, and it refuses to put two
//! uncorrelated entries into one grant. `(read, A)` and `(write, B)` come out
//! as two grants, never as one grant whose lists cross to `write A`.

use crate::permission::entry::PermissionEntry;
use crate::permission::set::PermissionSet;
use crate::{DomainError, Grant};

impl Grant {
    /// This grant's authority in correlated form.
    ///
    /// # Errors
    ///
    /// Propagates [`PermissionEntry::new`] — an action name or selector this
    /// grant carries that the selector grammar refuses is an error here rather
    /// than a silently dead pattern at check time.
    pub fn permission_set(&self) -> Result<PermissionSet, DomainError> {
        if self.actions.is_empty() || self.resources.is_empty() {
            return Ok(PermissionSet::empty());
        }
        PermissionSet::from_flat(&self.actions, &self.resources)
    }

    /// True when this grant authorizes `action` **on** `resource`.
    ///
    /// One check over one entry, replacing "is the action in the action list?"
    /// and "is the resource in the resource list?" asked separately. For a
    /// flat grant the answer is the same, which is the point: the call site
    /// stops being able to ask half the question, and gains nothing it did not
    /// already have.
    #[must_use]
    pub fn permits(&self, action: &str, resource: &str) -> bool {
        self.permission_set()
            .is_ok_and(|set| set.permits(action, resource))
    }
}

/// The flat `(actions, resources)` pairs to issue for a correlated set.
///
/// One pair per entry. A caller that wants a single grant must first prove the
/// set flattens losslessly with [`PermissionSet::flatten_lossless`]; this
/// function does not offer the choice, because the choice is where the pair
/// nobody granted gets added.
#[must_use]
pub fn issue_flat(set: &PermissionSet) -> Vec<(Vec<String>, Vec<String>)> {
    set.split_flat()
}

/// Check a flat grant against the entry a correlated approval recorded.
///
/// # Errors
///
/// Returns [`DomainError::PermissionCorrelationLost`] when the grant's flat
/// lists authorize a pair the approved entry does not. A grant minted from one
/// entry stays inside it; a grant minted by unioning several does not, and
/// this is where that shows up.
pub fn assert_flat_grant_matches_entry(
    grant: &Grant,
    approved: &PermissionEntry,
) -> Result<(), DomainError> {
    let set = grant.permission_set()?;
    for entry in set.entries() {
        for (action, scope) in entry.pairs() {
            if !(approved.permits_action(action)
                && approved
                    .scopes()
                    .iter()
                    .any(|allowed| allowed.contains(scope)))
            {
                return Err(DomainError::PermissionCorrelationLost(format!(
                    "{action} on {scope}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConnectionId, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId};
    use chrono::{Duration, Utc};

    fn grant(actions: &[&str], resources: &[&str]) -> Grant {
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
            project_id: None,
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: actions.iter().map(|a| (*a).to_string()).collect(),
            resources: resources.iter().map(|r| (*r).to_string()).collect(),
            constraints: GrantConstraints {
                audiences: vec![],
                not_before: None,
                expires_at: now + Duration::hours(1),
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: std::collections::BTreeMap::default(),
                maximum_delegation_depth: 0,
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
    fn a_flat_grant_reads_as_exactly_one_entry() {
        let set = grant(&["read", "write"], &["repo:acme/a", "repo:acme/b"])
            .permission_set()
            .unwrap();
        assert_eq!(set.entries().len(), 1);
        assert!(set.permits("write", "repo:acme/a"));
    }

    #[test]
    fn permits_asks_for_both_halves_at_once() {
        let g = grant(&["repository.read"], &["repo:acme/catalog"]);
        assert!(g.permits("repository.read", "repo:acme/catalog"));
        assert!(!g.permits("repository.admin", "repo:acme/catalog"));
        assert!(!g.permits("repository.read", "repo:victim/secrets"));
        // Agrees with the resource-only check it supersedes.
        assert!(g.permits_resource("repo:acme/catalog"));
    }

    #[test]
    fn an_empty_list_authorizes_nothing_rather_than_erroring() {
        assert!(grant(&["read"], &[]).permission_set().unwrap().is_empty());
        assert!(grant(&[], &["repo:acme/a"])
            .permission_set()
            .unwrap()
            .is_empty());
        assert!(!grant(&["read"], &[]).permits("read", "repo:acme/a"));
    }

    #[test]
    fn a_selector_the_grammar_refuses_never_silently_matches() {
        let g = grant(&["read"], &["repo:acme*"]);
        assert!(g.permission_set().is_err());
        assert!(!g.permits("read", "repo:acme-private/secrets"));
    }

    #[test]
    fn one_grant_per_entry_is_the_only_issuance() {
        let set = PermissionSet::new(vec![
            PermissionEntry::new(&["read"], &["repo:acme/a"]).unwrap(),
            PermissionEntry::new(&["write"], &["repo:acme/b"]).unwrap(),
        ])
        .unwrap();
        let pairs = issue_flat(&set);
        assert_eq!(pairs.len(), 2);

        // Each issued grant matches the entry it came from, and neither of
        // them crosses into the other's pair.
        for (index, (actions, resources)) in pairs.iter().enumerate() {
            let issued = grant(
                &actions.iter().map(String::as_str).collect::<Vec<_>>(),
                &resources.iter().map(String::as_str).collect::<Vec<_>>(),
            );
            let entry = &set.entries()[index];
            assert!(assert_flat_grant_matches_entry(&issued, entry).is_ok());
        }
        assert!(!grant(&["write"], &["repo:acme/a"]).permits("read", "repo:acme/a"));
    }

    #[test]
    fn a_grant_unioned_from_two_entries_is_caught_against_either() {
        let crossed = grant(&["read", "write"], &["repo:acme/a", "repo:acme/b"]);
        let approved = PermissionEntry::new(&["read"], &["repo:acme/a"]).unwrap();
        let error = assert_flat_grant_matches_entry(&crossed, &approved).unwrap_err();
        assert!(
            matches!(error, DomainError::PermissionCorrelationLost(_)),
            "{error}"
        );
    }

    #[test]
    fn a_grant_inside_its_entry_passes() {
        let narrow = grant(&["read"], &["repo:acme/catalog"]);
        let approved = PermissionEntry::new(&["read", "write"], &["repo:acme/*"]).unwrap();
        assert!(assert_flat_grant_matches_entry(&narrow, &approved).is_ok());
    }
}
