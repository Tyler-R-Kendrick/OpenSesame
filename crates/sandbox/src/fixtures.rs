//! Grant-chain builders for tests, behind the `fixtures` feature.
//!
//! The sandbox only accepts authority in one shape — a
//! [`ValidatedGrantChain`] — so a test needs real grants that really
//! attenuate. Building those by hand in every test file would mean every
//! test re-deriving the lineage rules, so the builders live here and the
//! rules stay in `opensesame-domain` where they belong.
//!
//! These are fixtures, not a second grant API: nothing here can produce a
//! chain that `ValidatedGrantChain::try_validate` would reject, because it
//! is the only way out of this module.

use chrono::{Duration, Utc};
use opensesame_domain::{
    ConnectionId, DomainError, Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId,
    PrincipalId, ProjectId, ValidatedGrantChain,
};

/// A root grant naming `actions`, metering `budgets`, valid for `ttl`.
#[must_use]
pub fn root_grant(actions: &[&str], budgets: &[(&str, i64)], ttl: Duration) -> Grant {
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
        actions: actions.iter().map(|a| (*a).to_owned()).collect(),
        resources: vec!["run:acme/*".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.example".into()],
            not_before: None,
            expires_at: now + ttl,
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: budgets.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
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

/// A child that attenuates `parent`: a subset of its actions, and budget
/// values no larger on every key the parent metered.
#[must_use]
pub fn child_of(parent: &Grant, actions: &[&str], budgets: &[(&str, i64)]) -> Grant {
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    child.actions = actions.iter().map(|a| (*a).to_owned()).collect();
    child.constraints.maximum_delegation_depth = parent
        .constraints
        .maximum_delegation_depth
        .saturating_sub(1);
    child.constraints.expires_at = parent.constraints.expires_at - Duration::seconds(1);
    // Keep every key the parent metered; a child may only lower a value.
    for (key, parent_value) in &parent.constraints.budgets {
        let requested = budgets
            .iter()
            .find(|(k, _)| k == key)
            .map_or(*parent_value, |(_, v)| *v);
        child
            .constraints
            .budgets
            .insert(key.clone(), requested.min(*parent_value));
    }
    child
}

/// Validate a lineage into the proof the sandbox requires.
///
/// # Errors
///
/// Propagates whatever `ValidatedGrantChain::try_validate` refuses.
pub fn chain(grants: &[Grant], generation: u64) -> Result<ValidatedGrantChain, DomainError> {
    ValidatedGrantChain::try_validate(grants, Utc::now(), generation)
}

/// The common case: one root grant, validated at generation 0.
///
/// # Panics
///
/// Panics if the fixture itself is malformed — that is a bug in this
/// module, not a condition a caller can recover from.
#[must_use]
pub fn single_chain(actions: &[&str], budgets: &[(&str, i64)]) -> ValidatedGrantChain {
    let root = root_grant(actions, budgets, Duration::hours(1));
    chain(&[root], 0).expect("fixture root grant validates")
}

/// A root grant with every sandbox capability and the ceiling budget.
///
/// # Panics
///
/// Panics if the fixture itself is malformed.
#[must_use]
pub fn full_capability_chain() -> ValidatedGrantChain {
    single_chain(
        &[
            "sandbox.emit",
            "sandbox.http",
            "sandbox.sign",
            "sandbox.token",
        ],
        &[],
    )
}
