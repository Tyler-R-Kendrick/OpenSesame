//! Named AT-* adversarial acceptance regressions for general authority.
//! See `docs/implementation/general-authority/adversarial-matrix.md`.
//! Local-only; Discord/Blocky live SaaS cases stay documented as still-open.


use crate::access_domain::{AccessDomain, AccessDomainForest, Realm};
use crate::cohort_fixture::{fixture, graph_with_team, live_cohort, mint, nested_member, t0};
use crate::permission::{PermissionEntry, PermissionRole, PermissionSet, RoleCatalog};
use crate::{
    AdmissionBasis, AdmissionMode, CohortGraph, CohortId, CohortSnapshot, CohortSnapshotId,
    DomainError, FrozenIntentV2, Grant, GrantConstraints, GrantId, Intent, IntentId, OfflineUse,
    OrganizationId, PrincipalId, ProjectId, TaskRunId, ValidatedGrantChain,
};
use chrono::{Duration, Utc};
use serde_json::json;

fn constrained_parent() -> Grant {
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
        environment_id: None,
        connection_id: None,
        actions: vec!["repository.read".into()],
        resources: vec!["repo:acme/*".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.example".into()],
            not_before: Some(now),
            expires_at: now + Duration::hours(2),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: Some(600),
            allowed_networks: vec!["10.0.0.0/8".into()],
            parameter_rules_digest: Some("sha256:rules-a".into()),
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

fn child_of(parent: &Grant) -> Grant {
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    child.issuer_principal_id = parent.beneficiary_principal_id;
    child.beneficiary_principal_id = PrincipalId::new();
    child.proof_key_thumbprint = Some(format!("jkt:{}", child.id));
    child.created_at = parent.created_at + Duration::seconds(1);
    child.resources = vec!["repo:acme/catalog".into()];
    child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
    child.constraints.authentication_max_age_seconds = Some(300);
    child.constraints.budgets.insert("calls".into(), 5);
    child.constraints.maximum_delegation_depth = 1;
    child
}

fn attenuation_refused(parent: &Grant, child: &Grant) -> String {
    match Grant::validate_attenuation(parent, child) {
        Err(DomainError::GrantAttenuation(why)) => why,
        other => panic!("expected attenuation refusal, got {other:?}"),
    }
}

fn sample_intent() -> Intent {
    let now = Utc::now();
    Intent {
        id: IntentId::new(),
        organization_id: OrganizationId::new(),
        project_id: None,
        principal_id: PrincipalId::new(),
        actor_id: crate::ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "repository.read".into(),
        resource: "repo:acme/x".into(),
        audience: "https://api.example".into(),
        normalized_parameters_hash: "sha256:params".into(),
        body_hash: None,
        nonce: "n".into(),
        idempotency_key: "ik".into(),
        issued_at: now,
        expires_at: now + Duration::hours(1),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: crate::DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "thumb".into(),
            signature: "sig".into(),
        },
    }
}

/// AT-REALM-ID — a domain from another realm cannot enter this forest.
#[test]
fn at_realm_id_cross_realm_domain_refused() {
    let mut forest = AccessDomainForest::new(Realm::standard(None, ProjectId::new()));
    let stranger = AccessDomain::root(
        crate::AccessDomainId::new(),
        Realm::standard(None, ProjectId::new()),
        "platform",
        "Platform",
        Utc::now(),
    )
    .expect("valid node");
    assert!(matches!(
        forest.insert(stranger),
        Err(DomainError::AccessDomainRealmMismatch(_))
    ));
}

/// AT-NOT-BEFORE — a child may not start earlier than its parent, or drop nbf.
#[test]
fn at_not_before_parent_start_bypass_refused() {
    let parent = constrained_parent();
    let mut earlier = child_of(&parent);
    earlier.constraints.not_before = Some(parent.created_at - Duration::hours(1));
    assert!(attenuation_refused(&parent, &earlier).contains("not_before"));

    let mut dropped = child_of(&parent);
    dropped.constraints.not_before = None;
    assert!(attenuation_refused(&parent, &dropped).contains("not_before"));
}

/// AT-PARAMETERS — parameter-rules digest and frozen-intent args cannot drift.
#[test]
fn at_parameters_digest_and_frozen_intent_refused() {
    let parent = constrained_parent();
    let mut swapped = child_of(&parent);
    swapped.constraints.parameter_rules_digest = Some("sha256:rules-b".into());
    assert!(attenuation_refused(&parent, &swapped).contains("parameter_rules_digest"));

    let legacy = sample_intent();
    let mut frozen = FrozenIntentV2::from_legacy(
        &legacy,
        TaskRunId::new(),
        1,
        "state-digest".into(),
        json!({"branch": "main", "method": "GET"}),
    )
    .unwrap();
    frozen.intent_digest = frozen.compute_digest().unwrap();
    assert!(frozen.assert_digest().is_ok());

    frozen.canonical_arguments = json!({"branch": "evil", "method": "GET"});
    assert!(
        frozen.assert_digest().is_err(),
        "changing reviewed parameters must invalidate the approved digest"
    );
}

/// AT-ROLE-EDIT — roles are not redefined in place; issued entries stay frozen.
#[test]
fn at_role_edit_envelope_does_not_expand() {
    let mut catalog = RoleCatalog::new();
    catalog
        .define(
            PermissionRole::new(
                "reader",
                vec![PermissionEntry::new(&["read"], &["repo:acme/catalog"]).unwrap()],
            )
            .unwrap(),
        )
        .unwrap();
    let issued = catalog.expand(&["reader"]).unwrap();
    assert!(!issued.permits("write", "repo:acme/catalog"));

    let wider = PermissionRole::new(
        "reader",
        vec![PermissionEntry::new(&["read", "write"], &["repo:acme/*"]).unwrap()],
    )
    .unwrap();
    assert!(catalog.define(wider).is_err());
    let still = catalog.expand(&["reader"]).unwrap();
    assert_eq!(still, issued);
    assert!(!still.permits("write", "repo:acme/catalog"));
}

/// AT-SNAPSHOT-ADD — an unreviewed principal added after snapshot gets nothing.
#[test]
fn at_snapshot_add_unreviewed_principal_gets_nothing() {
    let frozen = fixture(AdmissionMode::Snapshot);
    let resolution = frozen.graph.resolve(frozen.cohort.id, t0()).unwrap();
    let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();
    let attacker = PrincipalId::new();

    let live_with_attacker =
        graph_with_team(frozen.graph.clone(), frozen.team_id, &[frozen.dana, frozen.ridley, attacker]);
    assert!(live_with_attacker
        .resolve(frozen.cohort.id, t0())
        .unwrap()
        .eligibility(attacker)
        .is_some());

    assert!(
        snapshot.eligibility(attacker).is_none(),
        "snapshot taken before the add must not name the attacker"
    );
    assert!(mint(
        &frozen.cohort,
        AdmissionBasis::Snapshot(&snapshot),
        attacker,
        t0()
    )
    .is_err());
}

/// AT-SNAPSHOT-REMOVE — remove then re-add does not resurrect a closed snapshot.
#[test]
fn at_snapshot_remove_then_readd_does_not_resurrect() {
    let frozen = fixture(AdmissionMode::Snapshot);
    let taken = CohortSnapshot::take(
        CohortSnapshotId::new(),
        &frozen.graph.resolve(frozen.cohort.id, t0()).unwrap(),
    )
    .unwrap();
    assert!(mint(
        &frozen.cohort,
        AdmissionBasis::Snapshot(&taken),
        frozen.ridley,
        t0()
    )
    .is_ok());

    let closed = taken.close(t0() + Duration::minutes(1));
    let readded = graph_with_team(
        frozen.without_ridley(),
        frozen.team_id,
        &[frozen.dana, frozen.ridley],
    );
    assert!(readded
        .resolve(frozen.cohort.id, t0())
        .unwrap()
        .eligibility(frozen.ridley)
        .is_some());
    assert!(matches!(
        mint(
            &frozen.cohort,
            AdmissionBasis::Snapshot(&closed),
            frozen.ridley,
            t0()
        )
        .unwrap_err(),
        DomainError::CohortSnapshotClosed(_)
    ));
}

/// AT-COHORT-CYCLE — cyclic nesting is refused transactionally.
#[test]
fn at_cohort_cycle_refused() {
    let organization_id = OrganizationId::new();
    let (root, a, b, c) = (
        CohortId::new(),
        CohortId::new(),
        CohortId::new(),
        CohortId::new(),
    );
    let graph = CohortGraph::new()
        .with_cohort(live_cohort(
            root,
            organization_id,
            &[nested_member(a), nested_member(b)],
        ))
        .with_cohort(live_cohort(a, organization_id, &[nested_member(c)]))
        .with_cohort(live_cohort(c, organization_id, &[nested_member(b)]))
        .with_cohort(live_cohort(b, organization_id, &[nested_member(a)]));
    assert!(matches!(
        graph.validate(root).unwrap_err(),
        DomainError::CohortCycle(_)
    ));
    assert!(graph.resolve(root, t0()).is_err());
}

/// AT-CROSS-GRANT — action from one entry + resource from another is refused.
#[test]
fn at_cross_grant_action_resource_recombination_refused() {
    let honest = PermissionSet::new(vec![
        PermissionEntry::new(&["read"], &["repo:acme/a"]).unwrap(),
        PermissionEntry::new(&["write"], &["repo:acme/b"]).unwrap(),
    ])
    .unwrap();
    assert!(!honest.permits("write", "repo:acme/a"));
    assert!(honest.flatten_lossless().is_err());

    let cross = PermissionSet::new(vec![PermissionEntry::new(&["write"], &["repo:acme/a"]).unwrap()])
        .unwrap();
    assert!(!cross.attenuates(&honest));

    // Assembling flats from two grants would invent write-on-a; issuance must
    // keep separate entries (or split_flat) rather than from_flat the union.
    let attacked = PermissionSet::from_flat(&["read", "write"], &["repo:acme/a", "repo:acme/b"])
        .unwrap();
    assert!(attacked.permits("write", "repo:acme/a"));
    assert!(
        !attacked.attenuates(&honest),
        "a cross-product assembly must not attenuate under correlated parents"
    );
}

/// AT-APPROVAL-STALE — approval digests bind reviewed intent; drift fails closed.
#[test]
fn at_approval_stale_intent_digest_refused() {
    let legacy = sample_intent();
    let approved = FrozenIntentV2::from_legacy(
        &legacy,
        TaskRunId::new(),
        1,
        "state-digest".into(),
        json!({"url": "https://api.example/v1", "branch": "main"}),
    )
    .unwrap();
    let approved_digest = approved.intent_digest.clone();

    let mut changed = approved.clone();
    changed.canonical_arguments = json!({"url": "https://evil.example/v1", "branch": "main"});
    changed.intent_digest = approved_digest;
    assert!(
        changed.assert_digest().is_err(),
        "an approval of the prior intent must not settle the changed one"
    );
}

/// AT-UNKNOWN-FIELD — strict constraint schema rejects unknown / unknown-enum.
#[test]
fn at_unknown_field_schema_refused() {
    let err = serde_json::from_str::<GrantConstraints>(
        r#"{
            "audiences": [],
            "not_before": null,
            "expires_at": "2026-01-01T00:00:00Z",
            "required_assurance": null,
            "authentication_max_age_seconds": null,
            "allowed_networks": [],
            "parameter_rules_digest": null,
            "budgets": {},
            "maximum_delegation_depth": 0,
            "offline_use": "forbidden",
            "raw_credential_export": false,
            "smuggled_capability": true
        }"#,
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("unknown field") || err.to_string().contains("smuggled"),
        "{err}"
    );

    assert!(serde_json::from_str::<OfflineUse>(r#""pre_authorized_plus""#).is_err());
}

/// AT-RAW-PARENT — a forged parent pointer alone is not a validated chain.
#[test]
fn at_raw_parent_forged_pointer_not_validated_chain() {
    let parent = constrained_parent();
    let mut child = child_of(&parent);
    child.parent_grant_id = Some(GrantId::new());
    assert!(ValidatedGrantChain::try_validate(&[parent, child], Utc::now(), 0).is_err());
}

/// AT-CORRELATED — read-A + write-B never authorizes write-A.
#[test]
fn at_correlated_write_a_never_authorized() {
    let set = PermissionSet::new(vec![
        PermissionEntry::new(&["repository.read"], &["repo:acme/a"]).unwrap(),
        PermissionEntry::new(&["repository.write"], &["repo:acme/b"]).unwrap(),
    ])
    .unwrap();
    assert!(!set.permits("repository.write", "repo:acme/a"));
}

/// AT-OFFLINE / AT-BUDGET-OMIT — upgrades and omissions are refused.
#[test]
fn at_offline_and_budget_omit_refused() {
    let parent = constrained_parent();
    let mut offline = child_of(&parent);
    offline.constraints.offline_use = OfflineUse::PreAuthorized;
    assert!(attenuation_refused(&parent, &offline).contains("offline_use"));

    let mut omit = child_of(&parent);
    omit.constraints.budgets.clear();
    assert!(Grant::validate_attenuation(&parent, &omit).is_err());
}

