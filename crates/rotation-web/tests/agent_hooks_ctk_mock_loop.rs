//! The agent-hooks/0.1 Conformance Test Kit, run against the emission engine
//! through a scripted mock-agent loop (§13.2) — the second claim.
//!
//! `agent_hooks_ctk.rs` runs the corpus against the rotation host as it is:
//! a tool router with no model calls, which the corpus can reach at only four
//! vectors. This file runs the same corpus against the engine that host emits
//! through — `HookSession` and `host_run` — with the CTK's own mocked model and
//! tools driving it, so the composition, approval, identity, transform and
//! tool-seam vectors execute. The claim is about the emission and verdict
//! machinery; it says nothing about a rotation run, which makes no model call.
//! `docs/validation/agent-hooks-conformance.md` states both claims and what
//! each shows.
//!
//! The skip set is pinned by id: a vector that newly applies must pass, and a
//! skip is legitimate only for a capability this adapter does not declare.
//!
//! Run with `--nocapture` to see the per-part report a claim attaches.

mod ctk_common;
mod mock_loop_support;

use agent_hooks::ctk::{run_vector, VectorResult};
use ctk_common::{failures, part_counts, print_report, vectors};
use mock_loop_support::{MockLoopHarness, ADAPTER, CAPABILITIES};

async fn run_all() -> Vec<VectorResult> {
    let mut results = Vec::new();
    for vector in &vectors() {
        let mut harness = MockLoopHarness::default();
        results.push(run_vector(&mut harness, vector).await);
    }
    results
}

fn count(results: &[VectorResult], status: &str) -> usize {
    results.iter().filter(|r| r.status == status).count()
}

#[tokio::test]
async fn every_applicable_vector_passes_on_the_declared_surface() {
    let results = run_all().await;
    print_report(ADAPTER, &CAPABILITIES, &results);

    let failures = failures(&results);
    assert!(failures.is_empty(), "{failures:#?}");

    // Everything runs and passes except the one vector that needs a capability
    // this adapter does not declare, and it is skipped for that alone.
    let skipped: Vec<(&str, &str)> = results
        .iter()
        .filter(|r| r.status == "skip")
        .map(|r| (r.id.as_str(), r.detail.as_str()))
        .collect();
    assert_eq!(
        skipped,
        [("AH-CTK-091", "missing capabilities: [\"bigint_json\"]")]
    );
    assert_eq!(count(&results, "pass"), 46);
}

#[tokio::test]
async fn the_per_part_report_is_the_one_the_docs_state() {
    let results = run_all().await;
    let observed: Vec<(String, [usize; 3])> = part_counts(&results)
        .into_iter()
        .map(|(part, counts)| (part.to_owned(), counts))
        .collect();
    let expected: Vec<(String, [usize; 3])> = [
        ("(untagged)", [15, 0, 0]),
        ("approval_seam", [8, 0, 0]),
        ("composition/parallel_strictest", [3, 0, 0]),
        ("composition/parallel_unanimous", [2, 0, 0]),
        ("composition/sequential_first_deny", [2, 0, 0]),
        ("composition/sequential_run_all", [5, 0, 0]),
        ("enforcement/evaluate_only", [1, 0, 0]),
        ("enforcement/isolation", [1, 0, 0]),
        ("enforcement/post_action_deny", [1, 0, 0]),
        ("fail_closed/verdict_gate", [1, 0, 0]),
        ("identity_provider", [4, 0, 1]),
        ("record/decided_by", [1, 0, 0]),
        ("record/projection", [1, 0, 0]),
        ("verdict/warnings", [1, 0, 0]),
    ]
    .into_iter()
    .map(|(part, counts)| (part.to_owned(), counts))
    .collect();
    assert_eq!(observed, expected);
}
