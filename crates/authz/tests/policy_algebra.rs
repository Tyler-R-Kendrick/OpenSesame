//! POL-ALGEBRA: narrowing and meet, and the deny-on-unknown guardrail that
//! makes a term nobody implemented a refusal instead of a skipped check.

mod common;

use chrono::{Duration, Utc};
use common::{engine, grant, request, request_with, AUDIENCE, RESOURCE};
use opensesame_authz::{
    AssuranceLevel, Condition, ConditionKind, ConditionSet, DenyReason, EvidenceLedger,
    EvidencePolicy, PolicyQuery, RequestFacts, ResourceFact,
};
use opensesame_domain::{AvailabilityClass, Grant, GrantId, ValidatedGrantChain};
use serde_json::json;

fn actions(names: &[&str]) -> Condition {
    Condition::Actions(names.iter().map(|name| (*name).to_owned()).collect())
}

fn set(conditions: Vec<Condition>) -> ConditionSet {
    let mut set = ConditionSet::new();
    for condition in conditions {
        set.insert(condition)
            .expect("same-kind insert cannot fault");
    }
    set
}

#[test]
fn narrowing_is_transitive_and_an_omitted_dimension_is_a_widening() {
    let root = set(vec![
        actions(&["read", "write"]),
        Condition::RawExport(true),
    ]);
    let middle = set(vec![
        actions(&["read", "write"]),
        Condition::RawExport(false),
    ]);
    let leaf = set(vec![actions(&["read"]), Condition::RawExport(false)]);

    assert!(middle.narrows(&root).unwrap());
    assert!(leaf.narrows(&middle).unwrap());
    assert!(leaf.narrows(&root).unwrap(), "narrowing is transitive");
    assert!(!root.narrows(&leaf).unwrap());

    // Dropping a dimension the parent restricted is how an "omission" widens —
    // the same rule the domain applies to a missing budget key.
    let forgetful = set(vec![actions(&["read"])]);
    assert!(!forgetful.narrows(&root).unwrap());
}

#[test]
fn inserting_a_second_restriction_of_a_kind_takes_the_narrower_one() {
    let mut tightening = set(vec![actions(&["read", "write"])]);
    tightening.insert(actions(&["read"])).unwrap();
    assert_eq!(
        tightening.get(ConditionKind::Actions),
        Some(&actions(&["read"]))
    );

    // …in either order. A set cannot be widened by writing to it.
    let mut widening = set(vec![actions(&["read"])]);
    widening.insert(actions(&["read", "write"])).unwrap();
    assert_eq!(
        widening.get(ConditionKind::Actions),
        Some(&actions(&["read"]))
    );
}

#[test]
fn a_chains_effective_authority_is_the_meet_of_every_hop() {
    let now = Utc::now();
    let mut root = grant(now, "repository.read");
    root.actions = vec!["repository.read".into(), "repository.write".into()];
    root.resources = vec!["repo:acme/*".into()];
    root.constraints.maximum_delegation_depth = 1;

    let mut child = root.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(root.id);
    child.delegation_depth = 1;
    child.actions = vec!["repository.read".into()];
    child.resources = vec![RESOURCE.to_owned()];
    child.constraints.expires_at = root.constraints.expires_at - Duration::minutes(1);
    child.constraints.maximum_delegation_depth = 0;

    let chain = ValidatedGrantChain::try_validate(&[root.clone(), child.clone()], now, 0)
        .expect("attenuation-valid chain");
    let effective = ConditionSet::effective(&chain).unwrap();

    assert_eq!(
        effective.get(ConditionKind::Actions),
        Some(&actions(&["repository.read"])),
        "the intersection of both hops, not the wider root"
    );
    assert_eq!(
        effective.get(ConditionKind::NotAfter),
        Some(&Condition::NotAfter(child.constraints.expires_at)),
        "the earliest deadline in the chain"
    );
    assert!(
        effective
            .narrows(&ConditionSet::from_grant(&root).unwrap())
            .unwrap(),
        "the effective set narrows every hop it was folded from"
    );
    assert_eq!(ConditionSet::lineage_widening(&chain).unwrap(), None);
}

#[test]
fn a_leaf_that_widens_a_dimension_its_ancestors_restricted_is_caught() {
    // Read directly on the algebra: whatever any single hop check does or does
    // not cover, a leaf must narrow the meet of everything above it.
    let ancestors = set(vec![
        actions(&["repository.read"]),
        Condition::Audiences([AUDIENCE.to_owned()].into_iter().collect()),
    ]);
    let leaf = set(vec![
        actions(&["repository.read"]),
        Condition::Audiences(
            [AUDIENCE.to_owned(), "https://evil.example".to_owned()]
                .into_iter()
                .collect(),
        ),
    ]);
    assert!(!leaf.narrows(&ancestors).unwrap());
    assert!(
        leaf.meet(&ancestors).unwrap().narrows(&ancestors).unwrap(),
        "the meet is what the chain actually leaves"
    );
}

#[test]
fn an_unknown_resource_type_denies_instead_of_guessing_a_relation() {
    let engine = engine();
    let evidence = EvidenceLedger::new();
    let request = request_with(
        "read",
        "spaceship",
        "enterprise",
        json!({"connection_id": "connA", "audience": AUDIENCE}),
    );
    let verdict = engine.evaluate(&PolicyQuery {
        request: &request,
        grant: None,
        lineage: None,
        class: AvailabilityClass::A2AuthorityRequired,
        evidence: &evidence,
        evidence_policy: EvidencePolicy::Strict,
        now: Utc::now(),
    });
    assert!(!verdict.permitted());
    assert_eq!(
        verdict.explanation().decisive_code(),
        Some("unknown_resource_type")
    );
}

#[test]
fn an_unknown_required_assurance_denies_instead_of_ranking_zero() {
    // The bug: rank("quantum-resistant") == 0 and rank(held) == 0, so the
    // strongest-sounding requirement in the file was the weakest one enforced.
    let now = Utc::now();
    let mut grant: Grant = grant(now, "repository.read");
    grant.constraints.required_assurance = Some("quantum-resistant".into());
    let engine = engine();
    let evidence = EvidenceLedger::new().with_authentication(AssuranceLevel::Password, None);
    let request = request("repository.read");
    let verdict = engine.evaluate(&PolicyQuery {
        request: &request,
        grant: Some(&grant),
        lineage: None,
        class: AvailabilityClass::A3ExternalSideEffect,
        evidence: &evidence,
        evidence_policy: EvidencePolicy::Strict,
        now,
    });
    assert!(!verdict.permitted());
    assert_eq!(
        verdict.explanation().decisive_code(),
        Some("unknown_assurance_level")
    );
    assert_eq!(verdict.step_up_required(), None, "there is no such step-up");
}

#[test]
fn a_stated_audience_the_request_omits_is_unsatisfied() {
    let conditions = set(vec![Condition::Audiences(
        [AUDIENCE.to_owned()].into_iter().collect(),
    )]);
    let facts = RequestFacts {
        action: "repository.read",
        resource: ResourceFact::Named(RESOURCE),
        audience: None,
        invoke_level: None,
        exports_raw_credential: false,
        at: Utc::now(),
    };
    assert_eq!(
        conditions.check(&facts),
        Err(DenyReason::Condition(ConditionKind::Audiences))
    );
}

#[test]
fn a_grant_naming_no_resources_authorizes_none_of_them() {
    let now = Utc::now();
    let mut grant = grant(now, "repository.read");
    grant.resources.clear();
    let conditions = ConditionSet::from_grant(&grant).unwrap();
    let facts = RequestFacts {
        action: "repository.read",
        resource: ResourceFact::Named(RESOURCE),
        audience: Some(AUDIENCE),
        invoke_level: None,
        exports_raw_credential: false,
        at: now,
    };
    assert_eq!(
        conditions.check(&facts),
        Err(DenyReason::GrantResource(RESOURCE.to_owned()))
    );
}

#[test]
fn an_expired_grant_stops_permitting_when_its_deadline_passes() {
    let now = Utc::now();
    let grant = grant(now, "repository.read");
    let conditions = ConditionSet::from_grant(&grant).unwrap();
    let facts = |at| RequestFacts {
        action: "repository.read",
        resource: ResourceFact::Named(RESOURCE),
        audience: Some(AUDIENCE),
        invoke_level: None,
        exports_raw_credential: false,
        at,
    };
    assert!(conditions.check(&facts(now)).is_ok());
    assert_eq!(
        conditions.check(&facts(grant.constraints.expires_at + Duration::seconds(1))),
        Err(DenyReason::Condition(ConditionKind::NotAfter))
    );
}
