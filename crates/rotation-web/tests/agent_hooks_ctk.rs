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

mod ctk_support;

use std::collections::BTreeMap;
use std::path::PathBuf;

use agent_hooks::ctk::{load_vectors, run_vector, VectorResult};
use agent_hooks::{canonical_json, context_identity, AgentContext};
use ctk_support::{RotationWebHarness, CAPABILITIES};
use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/agent-hooks/conformance")
}

async fn run_all() -> Vec<VectorResult> {
    let vectors = load_vectors(corpus().join("vectors")).expect("the vendored corpus loads");
    assert_eq!(
        vectors.len(),
        47,
        "the v0.1.0-alpha.5 corpus has 47 vectors"
    );
    let mut results = Vec::with_capacity(vectors.len());
    for vector in &vectors {
        let mut harness = RotationWebHarness::default();
        results.push(run_vector(&mut harness, vector).await);
    }
    results
}

fn print_report(results: &[VectorResult]) {
    let mut parts: BTreeMap<&str, [usize; 3]> = BTreeMap::new();
    for result in results {
        let part = if result.part.is_empty() {
            "(untagged)"
        } else {
            &result.part
        };
        let slot = match result.status {
            "pass" => 0,
            "fail" => 1,
            _ => 2,
        };
        parts.entry(part).or_default()[slot] += 1;
    }
    println!("agent-hooks/0.1 CTK — opensesame-rotation-web, capabilities {CAPABILITIES:?}");
    println!("{:<40} {:>4} {:>4} {:>4}", "part", "pass", "fail", "skip");
    for (part, [pass, fail, skip]) in &parts {
        println!("{part:<40} {pass:>4} {fail:>4} {skip:>4}");
    }
    for result in results {
        let detail = if result.detail.is_empty() {
            String::new()
        } else {
            format!(" ({})", result.detail)
        };
        println!("{} {} {}{detail}", result.status, result.id, result.title);
    }
}

#[tokio::test]
async fn every_applicable_vector_passes_on_the_declared_surface() {
    let results = run_all().await;
    print_report(&results);

    let failures: Vec<String> = results
        .iter()
        .filter(|r| r.status == "fail")
        .map(|r| format!("{}: {:?}", r.id, r.failures))
        .collect();
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
        assert_eq!(
            canonical_json(&fixture["ctx"]),
            fixture["expect"]["canonical_json"]
                .as_str()
                .expect("canonical"),
            "{id}"
        );
        assert_eq!(
            context_identity(&context).expect("valid I-JSON"),
            fixture["expect"]["context_identity"]
                .as_str()
                .expect("identity"),
            "{id}"
        );
    }
}
