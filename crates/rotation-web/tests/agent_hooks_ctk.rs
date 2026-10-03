//! The agent-hooks/0.1 Conformance Test Kit, run against the hosted adapter
//! (§13.2).
//!
//! Every vector in the vendored corpus (`spec/agent-hooks/conformance`, pinned
//! to the SDK's tag) goes through `agent_hooks::ctk::run_vector`; 100% of the
//! non-skipped vectors must pass. The skip set is pinned by id, not by count,
//! so the report fails if it drifts in either direction — a vector that newly
//! applies to the declared surface must pass, not quietly join the skips.
//!
//! Run with `--nocapture` to see the per-part report a claim attaches.

mod ctk_common;
mod ctk_support;

use agent_hooks::ctk::{run_vector, VectorResult};
use agent_hooks::{canonical_json, context_identity, AgentContext};
use ctk_common::{corpus, failures, print_report, vectors};
use ctk_support::{RotationWebHarness, CAPABILITIES};
use serde_json::Value;
use sha2::{Digest, Sha256};

async fn run_all() -> Vec<VectorResult> {
    let mut results = Vec::new();
    for vector in &vectors() {
        let mut harness = RotationWebHarness::default();
        results.push(run_vector(&mut harness, vector).await);
    }
    results
}

#[tokio::test]
async fn every_applicable_vector_passes_on_the_declared_surface() {
    let results = run_all().await;
    print_report("opensesame-rotation-web", &CAPABILITIES, &results);

    let failures = failures(&results);
    assert!(failures.is_empty(), "{failures:#?}");

    let passed: Vec<&str> = results
        .iter()
        .filter(|r| r.status == "pass")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(
        passed,
        ["AH-CTK-011", "AH-CTK-022", "AH-CTK-061", "AH-CTK-074"]
    );

    // Every skip is a capability this host does not declare, and nothing else.
    for skipped in results.iter().filter(|r| r.status == "skip") {
        assert!(
            skipped.detail.contains("model_calls") || skipped.detail.contains("bigint_json"),
            "{} skipped for a reason other than an undeclared capability: {}",
            skipped.id,
            skipped.detail
        );
    }
    assert_eq!(results.iter().filter(|r| r.status == "skip").count(), 43);
}

#[test]
fn the_declared_identity_provider_meets_the_golden_vectors() {
    // §13.2: the golden identity vectors apply because the declared provider
    // is jcs-sha256 — the provider every hosted session uses by default.
    let text = std::fs::read_to_string(corpus().join("golden/identity.json")).expect("golden file");
    let doc: Value = serde_json::from_str(&text).expect("golden JSON");
    let fixtures = doc["fixtures"].as_array().expect("fixtures");
    assert!(!fixtures.is_empty());
    for fixture in fixtures {
        let id = &fixture["id"];
        let context: AgentContext =
            serde_json::from_value(fixture["ctx"].clone()).expect("context");
        if fixture["expect"].get("error").is_some() {
            let (error, _) = context_identity(&context).expect_err("out-of-domain fails closed");
            assert_eq!(error.to_string(), "host_error:context_invalid", "{id}");
            continue;
        }
        let mut canonical = fixture["expect"]["canonical_json"]
            .as_str()
            .expect("canonical")
            .to_owned();
        let mut identity = fixture["expect"]["context_identity"]
            .as_str()
            .expect("identity")
            .to_owned();
        if id == "G-15-rfc8785-numbers" {
            // The vendored vector expects `9.999999999999996e+22` for the input
            // `9.999999999999997e+22`; RFC 8785 Appendix B gives
            // `9.999999999999997e+22` (0x44b52d02c7e14af5). The SDK matches the
            // vector only when `serde_json` parses that number inexactly; this
            // build parses every number as the nearest double, as JSON.parse does
            // (ADR 0156 limits), so the vector is checked with the RFC's digits.
            canonical = canonical.replace("9.999999999999996e+22", "9.999999999999997e+22");
            identity = format!(
                "sha256:{}",
                hex::encode(Sha256::digest(canonical.as_bytes()))
            );
        }
        assert_eq!(canonical_json(&fixture["ctx"]), canonical, "{id}");
        assert_eq!(
            context_identity(&context).expect("valid I-JSON"),
            identity,
            "{id}"
        );
    }
}
