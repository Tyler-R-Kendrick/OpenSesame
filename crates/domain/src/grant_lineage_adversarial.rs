//! Adversarial suite for hierarchical grant authority.
//!
//! Every test here is a delegation that used to pass: a constraint dimension
//! attenuation never compared, a scope binding or issuer the child moved while
//! its actions and resources still read as a subset, or a lineage the child was
//! the only witness to.

use crate::{
    grant_lineage, ActorId, ClientId, ConnectionId, DomainError, EnvironmentId, Grant,
    GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId, ProjectId,
    ValidatedGrantChain,
};
use chrono::{Duration, Utc};

/// A parent that fences every dimension, so a child can be caught escaping any
/// one of them in isolation.
fn parent() -> Grant {
    let now = Utc::now();
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: Some("jkt:parent".into()),
        organization_id: OrganizationId::new(),
        project_id: Some(ProjectId::new()),
        environment_id: Some(EnvironmentId::new()),
        connection_id: Some(ConnectionId::new()),
        actions: vec!["repository.read".into(), "pull_request.create".into()],
        resources: vec!["repo:acme/*".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: Some(now),
            expires_at: now + Duration::hours(2),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: Some(600),
            allowed_networks: vec!["10.0.0.0/8".into()],
            parameter_rules_digest: Some("sha256:rules-a".into()),
            budgets: [("calls".into(), 10)].into_iter().collect(),
            maximum_delegation_depth: 2,
            offline_use: OfflineUse::ReadOnly,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

/// The holder delegating a strictly narrower grant onward: the one shape that
/// must keep passing, so every refusal below is about the perturbation and not
/// about the fixture.
fn child_of(parent: &Grant) -> Grant {
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    child.issuer_principal_id = parent.beneficiary_principal_id;
    child.beneficiary_principal_id = PrincipalId::new();
    // Its own holder key, so a chain of these re-keys at every hop.
    child.proof_key_thumbprint = Some(format!("jkt:{}", child.id));
    child.created_at = parent.created_at + Duration::seconds(1);
    child.actions = vec!["repository.read".into()];
    child.resources = vec!["repo:acme/catalog".into()];
    child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
    child.constraints.authentication_max_age_seconds = Some(300);
    child.constraints.budgets.insert("calls".into(), 5);
    child.constraints.maximum_delegation_depth = 1;
    child
}

fn refused(parent: &Grant, child: &Grant) -> String {
    match Grant::validate_attenuation(parent, child) {
        Err(DomainError::GrantAttenuation(why)) => why,
        Err(other) => panic!("expected an attenuation refusal, got {other:?}"),
        Ok(()) => panic!("attenuation accepted a widening child"),
    }
}

#[test]
fn baseline_child_attenuates() {
    let parent = parent();
    let child = child_of(&parent);
    assert!(Grant::validate_attenuation(&parent, &child).is_ok());
    // The issuance half stands alone, for a caller that has already compared
    // the authority two grants carry.
    assert!(grant_lineage::validate_issuance(&parent, &child).is_ok());
    assert!(grant_lineage::validate_delegator(&parent, &child).is_ok());
    assert!(grant_lineage::validate_proof_key_transfer(&parent, &child).is_ok());
    assert!(grant_lineage::validate_scope_containment(&parent, &child).is_ok());
}

#[test]
fn not_before_cannot_be_dropped_or_moved_earlier() {
    let parent = parent();
    let mut earlier = child_of(&parent);
    earlier.constraints.not_before = Some(parent.created_at - Duration::hours(1));
    assert!(refused(&parent, &earlier).contains("not_before"));

    let mut dropped = child_of(&parent);
    dropped.constraints.not_before = None;
    assert!(refused(&parent, &dropped).contains("not_before"));
}

#[test]
fn authentication_freshness_cannot_be_relaxed_or_dropped() {
    let parent = parent();
    let mut staler = child_of(&parent);
    staler.constraints.authentication_max_age_seconds = Some(86_400);
    assert!(refused(&parent, &staler).contains("authentication_max_age_seconds"));

    let mut dropped = child_of(&parent);
    dropped.constraints.authentication_max_age_seconds = None;
    assert!(refused(&parent, &dropped).contains("authentication_max_age_seconds"));
}

#[test]
fn required_assurance_cannot_be_weakened_dropped_or_renamed() {
    let parent = parent();
    let mut weaker = child_of(&parent);
    weaker.constraints.required_assurance = Some("pwd".into());
    assert!(refused(&parent, &weaker).contains("required_assurance"));

    let mut dropped = child_of(&parent);
    dropped.constraints.required_assurance = None;
    assert!(refused(&parent, &dropped).contains("required_assurance"));

    // An unrecognized name cannot be ranked, so it cannot be proven narrower.
    let mut unknown = child_of(&parent);
    unknown.constraints.required_assurance = Some("gold-star".into());
    assert!(refused(&parent, &unknown).contains("assurance"));

    let mut stronger = child_of(&parent);
    stronger.constraints.required_assurance = Some("phishing-resistant".into());
    assert!(Grant::validate_attenuation(&parent, &stronger).is_ok());
}

#[test]
fn allowed_networks_cannot_be_widened_or_cleared() {
    let parent = parent();
    let mut elsewhere = child_of(&parent);
    elsewhere
        .constraints
        .allowed_networks
        .push("0.0.0.0/0".into());
    assert!(refused(&parent, &elsewhere).contains("allowed_networks"));

    let mut anywhere = child_of(&parent);
    anywhere.constraints.allowed_networks.clear();
    assert!(refused(&parent, &anywhere).contains("allowed_networks"));
}

#[test]
fn parameter_rules_cannot_be_swapped_or_dropped() {
    let parent = parent();
    let mut swapped = child_of(&parent);
    swapped.constraints.parameter_rules_digest = Some("sha256:rules-b".into());
    assert!(refused(&parent, &swapped).contains("parameter_rules_digest"));

    let mut dropped = child_of(&parent);
    dropped.constraints.parameter_rules_digest = None;
    assert!(refused(&parent, &dropped).contains("parameter_rules_digest"));
}

#[test]
fn offline_use_climbs_only_downward() {
    let parent = parent();
    let mut preauthorized = child_of(&parent);
    preauthorized.constraints.offline_use = OfflineUse::PreAuthorized;
    assert!(refused(&parent, &preauthorized).contains("offline_use"));

    let mut forbidden = child_of(&parent);
    forbidden.constraints.offline_use = OfflineUse::Forbidden;
    assert!(Grant::validate_attenuation(&parent, &forbidden).is_ok());
}

#[test]
fn a_budget_survives_the_hop_it_is_left_out_of() {
    let parent = parent();
    // The hole: iterating only the child's keys means a child that stops
    // naming `calls` is unmetered, which is the widest possible reading.
    let mut unmetered = child_of(&parent);
    unmetered.constraints.budgets.clear();
    assert!(refused(&parent, &unmetered).contains("calls"));

    let mut raised = child_of(&parent);
    raised.constraints.budgets.insert("calls".into(), 11);
    assert!(refused(&parent, &raised).contains("calls"));

    // A meter the parent never named is a limit no enforcer knows to apply.
    let mut invented = child_of(&parent);
    invented.constraints.budgets.insert("bytes".into(), 1);
    assert!(refused(&parent, &invented).contains("bytes"));

    let mut negative = child_of(&parent);
    negative.constraints.budgets.insert("calls".into(), -1);
    assert!(refused(&parent, &negative).contains("calls"));
}

#[test]
fn resource_scope_narrows_by_bounded_containment_only() {
    let parent = parent();
    // Inside the parent's subtree: an exact member and a nested subtree.
    for inside in ["repo:acme/catalog", "repo:acme/team/*", "repo:acme/*"] {
        let mut child = child_of(&parent);
        child.resources = vec![inside.into()];
        let accepted = Grant::validate_attenuation(&parent, &child).is_ok();
        assert!(accepted, "{inside} is inside repo:acme/*");
    }
    // A shared string prefix is not containment, and no child wildcard may
    // reach above the parent's.
    for outside in ["repo:acme-private/catalog", "repo:*", "*", "repo:other/x"] {
        let mut child = child_of(&parent);
        child.resources = vec![outside.into()];
        assert!(refused(&parent, &child).contains("resources"), "{outside}");
    }
    // An exact parent resource does not cover the subtree beneath it either.
    let mut named = parent.clone();
    named.resources = vec!["repo:acme/catalog".into()];
    let mut subtree = child_of(&named);
    subtree.resources = vec!["repo:acme/catalog/*".into()];
    assert!(refused(&named, &subtree).contains("resources"));
}

#[test]
fn audiences_cannot_be_cleared_under_a_restricted_parent() {
    let parent = parent();
    let mut child = child_of(&parent);
    child.constraints.audiences.clear();
    assert!(refused(&parent, &child).contains("audiences"));
}

#[test]
fn only_the_parents_holder_or_issuer_may_mint_a_child() {
    let parent = parent();
    // A stranger who knows the parent's id: every dimension is a subset, and
    // the only claim of lineage is the pointer the stranger wrote.
    let mut stranger = child_of(&parent);
    stranger.issuer_principal_id = PrincipalId::new();
    assert!(refused(&parent, &stranger).contains("issuer"));

    let mut reissued = child_of(&parent);
    reissued.issuer_principal_id = parent.issuer_principal_id;
    assert!(Grant::validate_attenuation(&parent, &reissued).is_ok());
}

#[test]
fn a_lazily_materialized_parent_still_delegates() {
    // `created_at` is written by whoever mints, and an owner ceiling is
    // synthesized after the authority it stands for, so ordering says nothing.
    let parent = parent();
    let mut child = child_of(&parent);
    child.created_at = parent.created_at - Duration::hours(1);
    assert!(Grant::validate_attenuation(&parent, &child).is_ok());
}

#[test]
fn the_parent_pointer_must_name_the_parent_being_compared() {
    let parent = parent();
    let mut child = child_of(&parent);
    child.parent_grant_id = Some(GrantId::new());
    assert!(refused(&parent, &child).contains("parent_grant_id"));

    let mut orphan = child_of(&parent);
    orphan.parent_grant_id = None;
    assert!(refused(&parent, &orphan).contains("parent_grant_id"));
}

#[test]
fn a_proof_key_is_neither_dropped_nor_handed_on() {
    let parent = parent();
    let mut bearer = child_of(&parent);
    bearer.proof_key_thumbprint = None;
    assert!(refused(&parent, &bearer).contains("proof-of-possession"));

    // Keeping the parent's key while changing hands claims a possession the
    // new beneficiary never demonstrated.
    let mut transferred = child_of(&parent);
    transferred.proof_key_thumbprint = parent.proof_key_thumbprint.clone();
    assert!(refused(&parent, &transferred).contains("proof key"));

    // The same holder narrowing its own grant keeps its own key.
    let mut same_holder = child_of(&parent);
    same_holder.proof_key_thumbprint = parent.proof_key_thumbprint.clone();
    same_holder.beneficiary_principal_id = parent.beneficiary_principal_id;
    assert!(Grant::validate_attenuation(&parent, &same_holder).is_ok());
}

#[test]
fn scope_bindings_never_move_sideways() {
    fn moved(parent: &Grant, binding: &str, perturb: impl Fn(&mut Grant)) {
        let mut child = child_of(parent);
        perturb(&mut child);
        let why = refused(parent, &child);
        assert!(why.contains(binding), "{binding} moved: {why}");
    }

    let parent = parent();
    moved(&parent, "project", |c| {
        c.project_id = Some(ProjectId::new())
    });
    moved(&parent, "project", |c| c.project_id = None);
    moved(&parent, "environment", |c| {
        c.environment_id = Some(EnvironmentId::new())
    });
    moved(&parent, "environment", |c| c.environment_id = None);
    moved(&parent, "connection", |c| {
        c.connection_id = Some(ConnectionId::new())
    });
    moved(&parent, "connection", |c| c.connection_id = None);
}

#[test]
fn an_unbound_parent_may_be_narrowed_to_one_agent_but_not_re_pointed() {
    let parent = parent();
    let mut bound = child_of(&parent);
    bound.actor_id = Some(ActorId::new());
    bound.client_id = Some(ClientId::new());
    bound.constraints.maximum_delegation_depth = 2;
    assert!(Grant::validate_attenuation(&parent, &bound).is_ok());

    let mut grandchild = child_of(&bound);
    grandchild.constraints.maximum_delegation_depth = 0;
    grandchild.actor_id = Some(ActorId::new());
    assert!(refused(&bound, &grandchild).contains("actor"));
}

#[test]
fn a_validated_chain_is_the_only_proof_of_delegated_lineage() {
    let root = parent();
    let child = child_of(&root);
    let now = Utc::now();

    // The pointer alone: a stranger's grant that names the root.
    let mut forged = child.clone();
    forged.issuer_principal_id = PrincipalId::new();
    assert!(ValidatedGrantChain::try_validate(&[root.clone(), forged], now, 0).is_err());

    // A chain whose hops do not link, however plausible each grant looks.
    let mut unlinked = child.clone();
    unlinked.parent_grant_id = Some(GrantId::new());
    assert!(ValidatedGrantChain::try_validate(&[root.clone(), unlinked], now, 0).is_err());

    // A revoked ancestor takes the whole chain with it.
    let mut revoked_root = root.clone();
    revoked_root.revoked_at = Some(now);
    let mut under_revoked = child_of(&revoked_root);
    under_revoked.parent_grant_id = Some(revoked_root.id);
    assert_eq!(
        ValidatedGrantChain::try_validate(&[revoked_root, under_revoked], now, 0).err(),
        Some(DomainError::GrantRevoked)
    );

    let chain = ValidatedGrantChain::try_validate(&[root.clone(), child.clone()], now, 7)
        .expect("holder-delegated chain validates");
    assert_eq!(chain.leaf_id(), child.id);
    assert_eq!(chain.root_id(), root.id);
    assert_eq!(chain.invalidation_generation(), 7);
    assert!(chain.require_delegated_leaf().is_ok());
    // The smallest limit any ancestor set, not whichever grant is read last.
    assert_eq!(chain.effective_budgets().get("calls"), Some(&5));

    // A root on its own establishes nothing delegated.
    let root_only = ValidatedGrantChain::try_validate(&[root], now, 0).expect("root validates");
    assert!(root_only.require_delegated_leaf().is_err());
}

#[test]
fn a_replacement_inherits_every_dimension_check() {
    let parent = parent();
    let current = child_of(&parent);

    let mut narrower = current.clone();
    narrower.id = GrantId::new();
    narrower.constraints.budgets.insert("calls".into(), 2);
    assert!(Grant::validate_replacement(&parent, &current, &narrower).is_ok());

    // The parent still allows ReadOnly offline use, so attenuation against the
    // parent alone would let an "edit" grow back what the child gave up.
    let mut current_offline = child_of(&parent);
    current_offline.constraints.offline_use = OfflineUse::Forbidden;
    let mut wider = current_offline.clone();
    wider.id = GrantId::new();
    wider.constraints.offline_use = OfflineUse::ReadOnly;
    assert!(Grant::validate_attenuation(&parent, &wider).is_ok());
    assert!(Grant::validate_replacement(&parent, &current_offline, &wider).is_err());

    let mut unmetered = current.clone();
    unmetered.id = GrantId::new();
    unmetered.constraints.budgets.clear();
    assert!(Grant::validate_replacement(&parent, &current, &unmetered).is_err());
}
