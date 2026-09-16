//! POL-EVIDENCE: a requirement is satisfied by verified evidence or by nothing.
//! Asserting it, restating it, or holding a fact whose age nobody recorded are
//! all refusals.

mod common;

use chrono::{Duration, Utc};
use common::{engine, grant, request};
use opensesame_authz::{
    AssuranceLevel, EvidenceLedger, EvidencePolicy, PolicyQuery, Requirement, RequirementKind,
    Requirements, Verdict,
};
use opensesame_domain::{AvailabilityClass, Grant};

fn decide(
    engine: &opensesame_authz::PolicyEngine,
    grant: &Grant,
    evidence: &EvidenceLedger,
    policy: EvidencePolicy,
) -> Verdict {
    let request = request(&grant.actions[0]);
    engine.evaluate(&PolicyQuery {
        request: &request,
        grant: Some(grant),
        lineage: None,
        class: AvailabilityClass::A3ExternalSideEffect,
        evidence,
        evidence_policy: policy,
        now: Utc::now(),
    })
}

#[test]
fn an_asserted_assurance_is_not_evidence_of_one() {
    let now = Utc::now();
    let mut grant = grant(now, "repository.read");
    grant.constraints.required_assurance = Some("phishing-resistant".into());
    let engine = engine();

    // The request body may say anything; the ledger is what counts.
    let denied = decide(
        &engine,
        &grant,
        &EvidenceLedger::new(),
        EvidencePolicy::Strict,
    );
    assert!(!denied.permitted());
    assert_eq!(
        denied.explanation().decisive_code(),
        Some("evidence_missing")
    );
    assert_eq!(
        denied.step_up_required(),
        Some(AssuranceLevel::PhishingResistant)
    );

    let weak = decide(
        &engine,
        &grant,
        &EvidenceLedger::new().with_authentication(AssuranceLevel::Mfa, None),
        EvidencePolicy::Strict,
    );
    assert!(!weak.permitted());
    assert_eq!(weak.explanation().decisive_code(), Some("evidence_weak"));

    let verified = decide(
        &engine,
        &grant,
        &EvidenceLedger::new().with_authentication(AssuranceLevel::PhishingResistant, None),
        EvidencePolicy::Strict,
    );
    assert!(verified.permitted());
}

#[test]
fn a_freshness_requirement_needs_an_instant_somebody_recorded() {
    let now = Utc::now();
    let mut grant = grant(now, "repository.read");
    grant.constraints.required_assurance = Some("mfa".into());
    grant.constraints.authentication_max_age_seconds = Some(600);
    let engine = engine();
    let level_only = EvidenceLedger::new().with_authentication(AssuranceLevel::Mfa, None);

    let missing = decide(&engine, &grant, &level_only, EvidencePolicy::Strict);
    assert_eq!(
        missing.explanation().decisive_code(),
        Some("evidence_missing")
    );

    let stale = decide(
        &engine,
        &grant,
        &EvidenceLedger::new()
            .with_authentication(AssuranceLevel::Mfa, Some(now - Duration::hours(2))),
        EvidencePolicy::Strict,
    );
    assert_eq!(stale.explanation().decisive_code(), Some("evidence_stale"));

    let fresh = decide(
        &engine,
        &grant,
        &EvidenceLedger::new()
            .with_authentication(AssuranceLevel::Mfa, Some(now - Duration::seconds(60))),
        EvidencePolicy::Strict,
    );
    assert!(fresh.permitted());

    // The legacy facade's evidence set is narrower, and says so by name rather
    // than by quietly passing a requirement it never checked.
    let seam = decide(&engine, &grant, &level_only, EvidencePolicy::AssuranceOnly);
    assert!(seam.permitted());
    assert!(
        Requirements::from_grant(&grant)
            .unwrap()
            .as_slice()
            .iter()
            .any(|requirement| requirement.kind() == RequirementKind::AuthenticationFreshness),
        "the requirement is still stated; only this path defers it"
    );
}

#[test]
fn an_authentication_dated_in_the_future_is_not_a_fresh_one() {
    let now = Utc::now();
    let requirement = Requirement::AuthenticationNewerThan {
        max_age_seconds: 600,
    };
    let ahead = EvidenceLedger::new()
        .with_authentication(AssuranceLevel::Mfa, Some(now + Duration::hours(1)));
    assert!(requirement.satisfied_by(&ahead, now).is_err());
}

#[test]
fn proof_of_possession_needs_the_key_the_grant_names() {
    let now = Utc::now();
    let mut grant = grant(now, "repository.read");
    grant.proof_key_thumbprint = Some("jkt-owner".into());
    let engine = engine();

    let other_key = decide(
        &engine,
        &grant,
        &EvidenceLedger::new().with_proof_of_possession("jkt-somebody-else"),
        EvidencePolicy::Strict,
    );
    assert!(!other_key.permitted());
    assert_eq!(
        other_key.explanation().decisive_code(),
        Some("evidence_missing")
    );

    let bound = decide(
        &engine,
        &grant,
        &EvidenceLedger::new().with_proof_of_possession("jkt-owner"),
        EvidencePolicy::Strict,
    );
    assert!(bound.permitted());
}

#[test]
fn a_requirement_never_satisfies_itself() {
    let now = Utc::now();
    let mut grant = grant(now, "repository.read");
    grant.constraints.required_assurance = Some("mfa".into());
    let requirements = Requirements::from_grant(&grant).unwrap();
    // Restating the requirement — the shape a request body would carry — leaves
    // the ledger empty, and an empty ledger satisfies nothing.
    assert!(requirements.check(&EvidenceLedger::new(), now).is_err());
    assert!(requirements
        .check(
            &EvidenceLedger::new().with_authentication(AssuranceLevel::Mfa, None),
            now
        )
        .is_ok());
}
