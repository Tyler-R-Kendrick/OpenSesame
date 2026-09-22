//! Complete grant attenuation / replacement dimension checks (INV-ATTENUATE).
//!
//! `Grant::validate_attenuation` historically checked only a subset of constraint
//! dimensions. Omitting a restrictive parent budget key, dropping `not_before`,
//! relaxing offline mode, or forging a weaker assurance requirement must fail.

use crate::{resource_pattern_matches, DomainError, Grant, GrantConstraints, OfflineUse};

/// Child may only narrow (or keep) every inherited restriction.
///
/// # Errors
///
/// [`DomainError::GrantAttenuation`] naming the first dimension the child
/// widened: validity window, assurance, authentication age, networks,
/// parameter rules, offline use, or a budget key.
pub fn validate_constraint_attenuation(
    parent: &GrantConstraints,
    child: &GrantConstraints,
) -> Result<(), DomainError> {
    validate_time(parent, child)?;
    validate_assurance(parent, child)?;
    validate_auth_age(parent, child)?;
    validate_networks(parent, child)?;
    validate_parameter_rules(parent, child)?;
    validate_offline(parent, child)?;
    crate::grant_budgets::validate_budget_attenuation(&parent.budgets, &child.budgets)?;
    Ok(())
}

/// Flat replacement against the grant being replaced (same dimensions, no depth rule).
///
/// # Errors
///
/// As [`validate_constraint_attenuation`]: the first dimension the
/// replacement widened.
pub fn validate_constraint_narrowing(
    current: &GrantConstraints,
    replacement: &GrantConstraints,
) -> Result<(), DomainError> {
    validate_constraint_attenuation(current, replacement)
}

/// Parent resource scope must contain every child selector (bounded algebra).
///
/// Exact IDs remain the default. A parent `prefix/*` or `prefix:*` may cover a
/// child exact id or a nested `prefix/…/*` under the same separator. A bare
/// string prefix never widens. A child wildcard is never covered by a parent
/// exact id.
#[must_use]
pub fn resources_attenuate(child: &[String], parent: &[String]) -> bool {
    child
        .iter()
        .all(|c| parent.iter().any(|p| resource_selector_contains(p, c)))
}

fn resource_selector_contains(parent: &str, child: &str) -> bool {
    if parent == "*" {
        return true;
    }
    if parent == child {
        return true;
    }
    // Parent pattern covers an exact child resource.
    if !is_wildcard_selector(child) && resource_pattern_matches(parent, child) {
        return true;
    }
    // Parent subtree covers a nested child subtree with the same separator.
    for sep in ['/', ':'] {
        let suffix = format!("{sep}*");
        let Some(parent_prefix) = parent.strip_suffix(&suffix) else {
            continue;
        };
        if parent_prefix.is_empty() {
            continue;
        }
        if let Some(child_prefix) = child.strip_suffix(&suffix) {
            if child_prefix.starts_with(parent_prefix)
                && (child_prefix.len() == parent_prefix.len()
                    || child_prefix.as_bytes().get(parent_prefix.len()) == Some(&(sep as u8)))
            {
                return true;
            }
        }
    }
    false
}

fn is_wildcard_selector(selector: &str) -> bool {
    selector == "*" || selector.ends_with("/*") || selector.ends_with(":*")
}

fn validate_time(parent: &GrantConstraints, child: &GrantConstraints) -> Result<(), DomainError> {
    if child.expires_at > parent.expires_at {
        return Err(DomainError::GrantAttenuation("lifetime expanded".into()));
    }
    // Missing child not_before under a restricted parent means "may start earlier".
    match (parent.not_before, child.not_before) {
        (Some(p), Some(c)) if c < p => {
            return Err(DomainError::GrantAttenuation(
                "not_before earlier than parent".into(),
            ));
        }
        (Some(_), None) => {
            return Err(DomainError::GrantAttenuation(
                "not_before omitted under restricted parent".into(),
            ));
        }
        _ => {}
    }
    if let Some(nbf) = child.not_before {
        if child.expires_at <= nbf {
            return Err(DomainError::GrantAttenuation(
                "empty or inverted validity interval".into(),
            ));
        }
    }
    Ok(())
}

fn assurance_rank(name: &str) -> Option<u8> {
    match name {
        "phishing-resistant" => Some(3),
        "mfa" => Some(2),
        "pwd" | "password" => Some(1),
        _ => None,
    }
}

fn validate_assurance(
    parent: &GrantConstraints,
    child: &GrantConstraints,
) -> Result<(), DomainError> {
    match (&parent.required_assurance, &child.required_assurance) {
        (None, _) => Ok(()),
        (Some(_), None) => Err(DomainError::GrantAttenuation(
            "required_assurance dropped".into(),
        )),
        (Some(p), Some(c)) => {
            let Some(pr) = assurance_rank(p) else {
                return Err(DomainError::GrantAttenuation(format!(
                    "unknown parent assurance {p}"
                )));
            };
            let Some(cr) = assurance_rank(c) else {
                return Err(DomainError::GrantAttenuation(format!(
                    "unknown child assurance {c}"
                )));
            };
            if cr < pr {
                return Err(DomainError::GrantAttenuation(
                    "required_assurance weakened".into(),
                ));
            }
            Ok(())
        }
    }
}

fn validate_auth_age(
    parent: &GrantConstraints,
    child: &GrantConstraints,
) -> Result<(), DomainError> {
    // A parent that set no maximum constrains nothing here.
    let Some(parent_max) = parent.authentication_max_age_seconds else {
        return Ok(());
    };
    match child.authentication_max_age_seconds {
        None => Err(DomainError::GrantAttenuation(
            "authentication_max_age_seconds omitted under restricted parent".into(),
        )),
        Some(child_max) if child_max > parent_max => Err(DomainError::GrantAttenuation(
            "authentication_max_age_seconds expanded".into(),
        )),
        Some(_) => Ok(()),
    }
}

fn validate_networks(
    parent: &GrantConstraints,
    child: &GrantConstraints,
) -> Result<(), DomainError> {
    if parent.allowed_networks.is_empty() {
        return Ok(());
    }
    if child.allowed_networks.is_empty() {
        return Err(DomainError::GrantAttenuation(
            "allowed_networks cleared under restricted parent".into(),
        ));
    }
    if !child
        .allowed_networks
        .iter()
        .all(|n| parent.allowed_networks.iter().any(|p| p == n))
    {
        return Err(DomainError::GrantAttenuation(
            "allowed_networks expanded".into(),
        ));
    }
    Ok(())
}

fn validate_parameter_rules(
    parent: &GrantConstraints,
    child: &GrantConstraints,
) -> Result<(), DomainError> {
    // A parent that pinned no rules digest constrains nothing here.
    let Some(parent_digest) = parent.parameter_rules_digest.as_ref() else {
        return Ok(());
    };
    match child.parameter_rules_digest.as_ref() {
        None => Err(DomainError::GrantAttenuation(
            "parameter_rules_digest dropped".into(),
        )),
        Some(child_digest) if child_digest != parent_digest => Err(DomainError::GrantAttenuation(
            "parameter_rules_digest changed without proven narrowing".into(),
        )),
        Some(_) => Ok(()),
    }
}

fn offline_rank(mode: &OfflineUse) -> u8 {
    match mode {
        OfflineUse::Forbidden => 0,
        OfflineUse::ReadOnly => 1,
        OfflineUse::PreAuthorized => 2,
    }
}

fn validate_offline(
    parent: &GrantConstraints,
    child: &GrantConstraints,
) -> Result<(), DomainError> {
    if offline_rank(&child.offline_use) > offline_rank(&parent.offline_use) {
        return Err(DomainError::GrantAttenuation("offline_use expanded".into()));
    }
    Ok(())
}

/// Lineage pointer + org + depth checks shared by attenuation entry points.
///
/// # Errors
///
/// [`DomainError::OrganizationMismatch`] when the child names another
/// organization, or [`DomainError::GrantAttenuation`] when it does not point
/// at its parent or does not increment the delegation depth by exactly one.
pub fn validate_lineage_pointers(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
    if child.organization_id != parent.organization_id {
        return Err(DomainError::OrganizationMismatch);
    }
    if child.parent_grant_id != Some(parent.id) {
        return Err(DomainError::GrantAttenuation(
            "child parent_grant_id must reference parent id".into(),
        ));
    }
    if child.delegation_depth != parent.delegation_depth + 1 {
        return Err(DomainError::GrantAttenuation(
            "delegation_depth must increment by 1".into(),
        ));
    }
    if child.constraints.maximum_delegation_depth > parent.constraints.maximum_delegation_depth {
        return Err(DomainError::GrantAttenuation(
            "maximum_delegation_depth expanded".into(),
        ));
    }
    if child.delegation_depth > parent.constraints.maximum_delegation_depth {
        return Err(DomainError::DelegationDepthExceeded);
    }
    if child.constraints.raw_credential_export && !parent.constraints.raw_credential_export {
        return Err(DomainError::GrantAttenuation(
            "export privilege expanded".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConnectionId, GrantId, OfflineUse, OrganizationId, PrincipalId, ProjectId};
    use chrono::{Duration, Utc};

    fn parent_grant() -> Grant {
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
            actions: vec!["repository.read".into()],
            resources: vec!["repo:acme/*".into()],
            constraints: GrantConstraints {
                audiences: vec!["https://api.example".into()],
                not_before: Some(now),
                expires_at: now + Duration::hours(2),
                required_assurance: Some("mfa".into()),
                authentication_max_age_seconds: Some(600),
                allowed_networks: vec!["10.0.0.0/8".into()],
                parameter_rules_digest: Some("digest-a".into()),
                budgets: [("calls".into(), 10)].into_iter().collect(),
                maximum_delegation_depth: 2,
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
    fn budget_omission_is_expansion() {
        let p = parent_grant().constraints;
        let mut c = p.clone();
        c.budgets.clear();
        assert!(validate_constraint_attenuation(&p, &c).is_err());
    }

    #[test]
    fn not_before_omission_under_parent_fails() {
        let p = parent_grant().constraints;
        let mut c = p.clone();
        c.not_before = None;
        c.budgets.insert("calls".into(), 5);
        assert!(validate_constraint_attenuation(&p, &c).is_err());
    }

    #[test]
    fn offline_upgrade_fails() {
        let p = parent_grant().constraints;
        let mut c = p.clone();
        c.budgets.insert("calls".into(), 5);
        c.offline_use = OfflineUse::PreAuthorized;
        assert!(validate_constraint_attenuation(&p, &c).is_err());
    }

    #[test]
    fn assurance_weakening_fails() {
        let p = parent_grant().constraints;
        let mut c = p.clone();
        c.budgets.insert("calls".into(), 5);
        c.required_assurance = Some("pwd".into());
        assert!(validate_constraint_attenuation(&p, &c).is_err());
    }

    #[test]
    fn subtree_resource_may_narrow_under_wildcard_parent() {
        assert!(resources_attenuate(
            &["repo:acme/catalog".into()],
            &["repo:acme/*".into()]
        ));
        assert!(!resources_attenuate(
            &["repo:acme/*".into()],
            &["repo:acme/catalog".into()]
        ));
        assert!(!resources_attenuate(
            &["repo:acme-other/x".into()],
            &["repo:acme/*".into()]
        ));
    }
}
