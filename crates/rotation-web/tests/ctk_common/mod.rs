//! What both CTK claims share (agent-hooks/0.1 §13.2): the vendored corpus,
//! the run's report, the §9 redaction convention, and the per-part table a
//! claim attaches. Nothing here knows which adapter is being run.

use std::collections::BTreeMap;
use std::path::PathBuf;

use agent_hooks::ctk::{load_vectors, VectorResult};
use agent_hooks::{apply_transform_to_ctx, AgentContext, Transform};
use opensesame_rotation_web::hooks::{InputRole, Reported};
use serde_json::{json, Value};

/// The vendored corpus, pinned to the SDK's tag.
pub fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/agent-hooks/conformance")
}

/// The whole corpus, and a check that it is the whole corpus.
pub fn vectors() -> Vec<Value> {
    let vectors = load_vectors(corpus().join("vectors")).expect("the vendored corpus loads");
    assert_eq!(
        vectors.len(),
        47,
        "the v0.1.0-alpha.5 corpus has 47 vectors"
    );
    vectors
}

/// The remote agent's final report, as the run's `output`.
pub struct AgentReport(pub Value);

impl Reported for AgentReport {
    fn report(&self) -> Value {
        self.0.clone()
    }
    fn restate(self, report: Value) -> Option<Self> {
        Some(Self(report))
    }
}

/// The CTK's §9 redaction convention: each listed path becomes "[redacted]";
/// a path that does not resolve at the escalating point is left alone.
pub fn redacted(context: &AgentContext, paths: &[String]) -> AgentContext {
    let mut shown = context.clone();
    for path in paths {
        let redaction = Transform {
            path: path.clone(),
            value: json!("[redacted]"),
        };
        let _ = apply_transform_to_ctx(&mut shown, &redaction);
    }
    shown
}

/// A scenario's `input.role`.
pub fn role(input: &Value) -> InputRole {
    match input["role"].as_str() {
        Some("system") => InputRole::System,
        Some("external") => InputRole::External,
        _ => InputRole::User,
    }
}

/// `[pass, fail, skip]` per `part` tag: the conformance report (§13.1).
pub fn part_counts(results: &[VectorResult]) -> BTreeMap<&str, [usize; 3]> {
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
    parts
}

/// Print the per-part report and one line per vector (`--nocapture`).
pub fn print_report(adapter: &str, capabilities: &[&str], results: &[VectorResult]) {
    println!("agent-hooks/0.1 CTK — {adapter}, capabilities {capabilities:?}");
    println!("{:<40} {:>4} {:>4} {:>4}", "part", "pass", "fail", "skip");
    for (part, [pass, fail, skip]) in &part_counts(results) {
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

/// Every vector that failed, as `id: failures`.
pub fn failures(results: &[VectorResult]) -> Vec<String> {
    results
        .iter()
        .filter(|r| r.status == "fail")
        .map(|r| format!("{}: {:?}", r.id, r.failures))
        .collect()
}
