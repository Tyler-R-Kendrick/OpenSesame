//! The custody steps are host-owned and deliberately not hooked (ADR 0159).
//!
//! `generate_candidate`, `seal_candidate` and `promote_candidate` are not in
//! the tool surface an agent calls: the Host mints the handle, the owner's
//! vault does the work, and every outcome is an acknowledgement that cannot
//! carry the candidate (`custody`). An interceptor never sees them, so a
//! policy cannot allow or deny them — and a policy that denied a hooked verb
//! must still stop them, because they are ordered behind the hooked steps
//! that precede them in the executor. These tests pin both halves: nothing
//! reaches the driver's queue unless the hooked `navigate` and `wait_for`
//! before it were allowed, and no hook decision is ever taken about them.

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use serde_json::{json, Value};

use super::test_support::*;
use crate::lifecycle::dispatch;

const CUSTODY: [&str; 3] = ["generate_candidate", "seal_candidate", "promote_candidate"];

/// The verbs a complete run hooks: the browser steps, not the custody ones.
const HOOKED_STEPS: usize = COMPLETE_RUN.len() - CUSTODY.len();

fn deny(verb: &str) -> String {
    json!({
        "version": 1,
        "unlisted_tools": "allow",
        "tools": [{"name": verb, "decision": "deny"}],
    })
    .to_string()
}

/// With no approval resolver, an escalation is a denial (§9).
fn escalate(verb: &str) -> String {
    json!({
        "version": 1,
        "unlisted_tools": "allow",
        "tools": [{"name": verb, "decision": "escalate"}],
    })
    .to_string()
}

/// The rotation preset's policy, from the file the presets are made of.
fn rotation_preset() -> String {
    let file: Value = serde_json::from_str(include_str!(
        "../../../../spec/agent-hooks/presets/rotation-web-login.json"
    ))
    .unwrap();
    file["policy"].to_string()
}

struct Ran {
    steps: Vec<String>,
    hook_records: Vec<opensesame_storage::web_login_runs::StoredAgentHookRecord>,
    job_state: String,
}

/// One rotation of `SITE` under `hook_policy`, with the owner's browser
/// answering every step it is handed, and what that left behind.
async fn rotate_under(hook_policy: &str) -> Ran {
    let world = world(&[SITE], hook_policy).await;
    let org = world.org_text();
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    let done = AtomicBool::new(false);
    tokio::join!(drive(&world.state, &org, &done, |_| async {}), async {
        world.state.web_login_runs.idle().await;
        done.store(true, Ordering::SeqCst);
    });
    let runs = world
        .state
        .db
        .list_observation_runs(&org, 10)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let jobs = world
        .state
        .connection_broker
        .list_rotation_jobs(&org, 10)
        .await
        .unwrap();
    Ran {
        steps: queued(&world.state.db, &runs[0].id).await,
        hook_records: world
            .state
            .db
            .agent_hook_records(&org, &runs[0].id)
            .await
            .unwrap(),
        job_state: jobs[0].state.clone(),
    }
}

fn custody_in(steps: &[String]) -> Vec<&str> {
    steps
        .iter()
        .map(String::as_str)
        .filter(|step| CUSTODY.contains(step))
        .collect()
}

fn tool_calls(ran: &Ran) -> usize {
    ran.hook_records
        .iter()
        .filter(|record| record.interception_point == "pre_tool_call")
        .count()
}

#[tokio::test]
async fn a_run_nothing_denies_hands_the_driver_custody_after_navigate_and_wait() {
    let ran = rotate_under(ALLOW_ALL).await;
    assert_eq!(ran.steps, COMPLETE_RUN);
    assert_eq!(ran.job_state, "completed");
    // Navigate and wait come first; custody is dispatched only behind them.
    let first_custody = ran
        .steps
        .iter()
        .position(|step| CUSTODY.contains(&step.as_str()))
        .unwrap();
    assert_eq!(ran.steps[..first_custody], ["navigate", "wait_for"]);
}

#[tokio::test]
async fn a_refused_navigate_or_wait_dispatches_no_custody_step() {
    // (the policy, what the driver may have been handed before the refusal)
    let refusals: [(String, &[&str]); 4] = [
        (deny("navigate"), &[]),
        (escalate("navigate"), &[]),
        (deny("wait_for"), &["navigate"]),
        (escalate("wait_for"), &["navigate"]),
    ];
    for (policy, expected) in refusals {
        let ran = rotate_under(&policy).await;
        assert_eq!(ran.steps, expected, "{policy}");
        assert!(custody_in(&ran.steps).is_empty(), "{policy}");
        assert_ne!(ran.job_state, "completed", "{policy}");
    }
}

#[tokio::test]
async fn a_hooked_step_is_decided_before_it_is_dispatched_and_custody_never_is() {
    let ran = rotate_under(ALLOW_ALL).await;
    assert_eq!(ran.steps.len(), COMPLETE_RUN.len());
    // Eleven steps reached the driver; eight of them were tool calls the
    // interceptor decided. The other three — the custody steps — were not.
    assert_eq!(tool_calls(&ran), HOOKED_STEPS);
    assert!(tool_calls(&ran) < ran.steps.len());
    // And what was decided was every hooked step, allowed.
    assert!(ran
        .hook_records
        .iter()
        .filter(|record| record.interception_point == "pre_tool_call")
        .all(|record| record.decision == "allow"));
}

#[tokio::test]
async fn a_policy_that_names_only_the_hooked_verbs_still_completes_the_custody_steps() {
    // The rotation preset denies every tool it does not name. The custody
    // steps are not tools it could name, and the run completes: if they were
    // hooked, this policy would refuse them.
    let ran = rotate_under(&rotation_preset()).await;
    assert_eq!(ran.steps, COMPLETE_RUN);
    assert_eq!(ran.job_state, "completed");
    assert_eq!(custody_in(&ran.steps), CUSTODY);
    assert_eq!(tool_calls(&ran), HOOKED_STEPS);
}
