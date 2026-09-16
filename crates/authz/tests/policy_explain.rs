//! POL-EXPLAIN: an explanation says which question refused and why, in stable
//! codes — and carries nothing the requester sent and nothing the engine holds.

mod common;

use chrono::Utc;
use common::{engine, grant, request_with, AUDIENCE, RESOURCE};
use opensesame_authz::{
    AssuranceLevel, Effect, EvidenceLedger, EvidencePolicy, PolicyLayer, PolicyQuery,
    MAX_DETAIL_LENGTH,
};
use opensesame_domain::AvailabilityClass;
use serde_json::json;

#[test]
fn an_explanation_names_the_layer_that_refused_and_a_stable_code() {
    let now = Utc::now();
    let grant = grant(now, "repository.read");
    let engine = engine();
    let evidence = EvidenceLedger::new().with_authentication(AssuranceLevel::Mfa, None);
    let request = request_with(
        "repository.read",
        "connector_operation",
        "repo:victim/secrets",
        json!({"connection_id": "connA", "audience": AUDIENCE}),
    );
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
    let explanation = verdict.explanation();
    assert_eq!(explanation.decisive_code(), Some("grant_resource"));
    assert_eq!(explanation.detail(), Some("repo:victim/secrets"));
    assert!(explanation.layer_effect(PolicyLayer::Relationship, Effect::Permit));
    assert!(explanation.layer_effect(PolicyLayer::Conditions, Effect::Deny));
    assert!(explanation.layer_effect(PolicyLayer::Lineage, Effect::NotApplicable));

    let json = explanation.to_json();
    assert_eq!(json["decision"], "deny");
    assert_eq!(json["reason"], "grant_resource");
    assert_eq!(
        json["layers"].as_array().expect("layers is an array").len(),
        7,
        "every question is reported, including the ones that had nothing to say"
    );
}

#[test]
fn a_permit_explains_the_obligations_it_carries() {
    let now = Utc::now();
    let grant = grant(now, "repository.read");
    let engine = engine();
    let evidence = EvidenceLedger::new().with_authentication(AssuranceLevel::Mfa, None);
    let request = request_with(
        "repository.read",
        "connector_operation",
        RESOURCE,
        json!({"connection_id": "connA", "audience": AUDIENCE}),
    );
    let verdict = engine.evaluate(&PolicyQuery {
        request: &request,
        grant: Some(&grant),
        lineage: None,
        class: AvailabilityClass::A3ExternalSideEffect,
        evidence: &evidence,
        evidence_policy: EvidencePolicy::Strict,
        now,
    });

    assert!(verdict.permitted());
    assert_eq!(verdict.explanation().decisive_code(), None);
    assert_eq!(
        verdict.explanation().to_json()["obligations"],
        json!(["receipt.required"])
    );
    let decision = verdict.decision();
    assert!(decision.decision);
    assert_eq!(decision.obligations.len(), 1);
    assert!(decision.policy_version_digest.starts_with("sha256:"));
}

#[test]
fn an_explanation_carries_nothing_the_caller_sent_and_nothing_the_engine_holds() {
    let now = Utc::now();
    let grant = grant(now, "repository.read");
    let engine = engine();
    let evidence =
        EvidenceLedger::new().with_authentication(AssuranceLevel::PhishingResistant, None);
    // A hostile request: a secret smuggled through the client-authored blobs, and
    // an action name that is long, newline-ridden and control-character laden.
    let hostile_action = format!("repository.{}{}", "A".repeat(4000), "\n\u{7}steal");
    let mut request = request_with(
        &hostile_action,
        "connector_operation",
        RESOURCE,
        json!({
            "connection_id": "connA",
            "audience": AUDIENCE,
            "note": "password=hunter2",
        }),
    );
    request.subject.properties = json!({"assurance": "phishing-resistant", "pat": "ghp_hunter2"});

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

    let rendered = verdict.explanation().to_json().to_string();
    assert!(!rendered.contains("hunter2"), "{rendered}");
    assert!(!rendered.contains("ghp_"), "{rendered}");
    assert!(
        !rendered.contains("phishing-resistant"),
        "what the caller authenticated with is not explained back to it: {rendered}"
    );
    let detail = verdict
        .explanation()
        .detail()
        .expect("a denied action explains which action");
    assert!(detail.len() <= MAX_DETAIL_LENGTH, "{}", detail.len());
    assert!(
        !detail.chars().any(char::is_control),
        "control characters are stripped before anything logs this"
    );
}
