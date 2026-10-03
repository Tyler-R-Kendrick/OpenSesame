//! A hooked web-login run whose policy escalates a verb, with the Identity API
//! replaced by a local server (ADR 0159): the run is held until the person is
//! reached and approves — an approval bound to this very request — and then
//! proceeds. A refusal, a deadline, an approval bound to some other request,
//! an organization nobody is named for, and a deployment with no approver all
//! leave that step undispatched.

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use opensesame_storage::agent_hook_policy::approver::{
    AgentHookApproverAudit, AgentHookApproverWrite,
};
use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use serde_json::{json, Value};

use super::identity_mock::{serve, IdentityMock, Mode};
use super::test_support::*;
use crate::agent_hook_approver::{
    ApproverSettings, ENV_BEARER, ENV_DEADLINE, ENV_POLL, ENV_TTL, ENV_URL, EVENT_APPROVER_UPDATED,
};
use crate::lifecycle::dispatch;

const BEARER: &str = "requester-bearer-for-the-run-tests";
const APPROVER: &str = "inbox_YXBwcm92ZXI.test-tag";

fn escalate(verb: &str) -> String {
    json!({
        "version": 1,
        "unlisted_tools": "allow",
        "tools": [{"name": verb, "decision": "escalate"}],
    })
    .to_string()
}

/// A world whose deployment reaches `mock`, and whose organization names
/// `approver` (when it names anybody).
async fn world_asking(
    mock: &IdentityMock,
    policy: &str,
    approver: Option<&str>,
    deadline: &str,
) -> World {
    let mut world = world(&[SITE], policy).await;
    let lookup = |name: &str| match name {
        ENV_URL => Some(mock.base.clone()),
        ENV_BEARER => Some(BEARER.to_owned()),
        ENV_TTL => Some("300".to_owned()),
        ENV_POLL => Some("10".to_owned()),
        ENV_DEADLINE => Some(deadline.to_owned()),
        _ => None,
    };
    world.state.agent_hook_approver = ApproverSettings::from_lookup(&lookup)
        .unwrap()
        .map(Into::into);
    if let Some(approver) = approver {
        world
            .state
            .db
            .put_agent_hook_approver(
                &AgentHookApproverWrite {
                    organization_id: &world.org_text(),
                    approver_ref: Some(approver),
                    expected_version: 0,
                    updated_by: "operator",
                },
                &AgentHookApproverAudit {
                    event_type: EVENT_APPROVER_UPDATED,
                    payload_json: "{}",
                },
            )
            .await
            .unwrap();
    }
    world
}

struct Ran {
    steps: Vec<String>,
    job_state: String,
    records: Vec<StoredAgentHookRecord>,
}

async fn outcome(world: &World) -> Ran {
    let org = world.org_text();
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
        job_state: jobs[0].state.clone(),
        records: world
            .state
            .db
            .agent_hook_records(&org, &runs[0].id)
            .await
            .unwrap(),
    }
}

/// One rotation of `SITE`. `while_held` runs once the run is waiting on a
/// person (the mock has been asked at least once), and says what the person
/// does; `expect_asked` is false for a run nobody is asked about.
async fn rotate<F, Fut>(
    world: &World,
    mock: &IdentityMock,
    expect_asked: bool,
    while_held: F,
) -> Ran
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let org = world.org_text();
    dispatch::publish(&world.state, &event(world, SITE), Utc::now()).await;
    let done = AtomicBool::new(false);
    tokio::join!(drive(&world.state, &org, &done, |_| async {}), async {
        if expect_asked {
            mock.until(|seen| seen.consumes >= 2).await;
            // Held: the run is open and the escalated step is not queued.
            let run = the_open_run(&world.state.db, &org).await;
            assert!(queued(&world.state.db, &run.id).await.is_empty());
        }
        while_held().await;
        world.state.web_login_runs.idle().await;
        done.store(true, Ordering::SeqCst);
    });
    outcome(world).await
}

fn navigate(ran: &Ran) -> &StoredAgentHookRecord {
    ran.records
        .iter()
        .find(|record| record.interception_point == "pre_tool_call")
        .expect("navigate is the first hooked step")
}

#[tokio::test]
async fn a_run_is_held_until_the_person_approves_the_request_it_was_bound_to() {
    let mock = serve(Mode::Pending, false).await;
    let world = world_asking(&mock, &escalate("navigate"), Some(APPROVER), "30").await;
    let ran = rotate(&world, &mock, true, || async {
        assert_eq!(
            mock.seen.lock().unwrap().spends,
            0,
            "nobody has approved yet"
        );
        mock.set(Mode::Approve);
    })
    .await;

    assert_eq!(ran.steps, COMPLETE_RUN, "approved, the run proceeds whole");
    assert_eq!(ran.job_state, "completed");

    let seen = mock.seen.lock().unwrap();
    assert_eq!((seen.auth_requests.len(), seen.interactions.len()), (1, 1));
    assert_eq!(seen.spends, 1, "one approval, spent once");
    assert_eq!((seen.revokes, seen.cancels.len()), (0, 0));
    assert!(seen
        .bearers
        .iter()
        .all(|bearer| bearer == &format!("Bearer {BEARER}")));
    // The person asked is the organization's approver.
    assert_eq!(seen.interactions[0]["approverRef"], APPROVER);
    // What they were asked about is this request: the identity inside the
    // details the server digests is the identity of the context the run's
    // record kept for that step.
    let detail = &seen.interactions[0]["authorizationDetails"][0];
    assert_eq!(detail["interception_point"], "pre_tool_call");
    assert_eq!(detail["locations"], json!(["navigate"]));
    let identity = detail["context_identity"].as_str().unwrap();
    assert!(identity.starts_with("sha256:"), "{identity}");
    assert_eq!(Some(identity), navigate(&ran).input_identity.as_deref());
    // It is the credential-free form: the run holds none, and none is sent.
    assert!(!seen.interactions[0].to_string().contains(BEARER));
}

#[tokio::test]
async fn a_person_who_declines_leaves_the_step_undispatched() {
    let mock = serve(Mode::Pending, false).await;
    let world = world_asking(&mock, &escalate("navigate"), Some(APPROVER), "30").await;
    let ran = rotate(&world, &mock, true, || async { mock.set(Mode::Decline) }).await;

    assert!(ran.steps.is_empty(), "{:?}", ran.steps);
    assert_ne!(ran.job_state, "completed");
    let record = navigate(&ran);
    assert_eq!(record.decision, "deny");
    assert_eq!(
        record.reason.as_deref(),
        Some("opensesame:approval_declined")
    );
    assert_eq!(mock.seen.lock().unwrap().spends, 0);
}

#[tokio::test]
async fn nobody_answering_before_the_deadline_leaves_the_step_undispatched_and_withdraws_the_ask() {
    let mock = serve(Mode::Pending, false).await;
    let world = world_asking(&mock, &escalate("navigate"), Some(APPROVER), "1").await;
    let ran = rotate(&world, &mock, true, || async {}).await;

    assert!(ran.steps.is_empty(), "{:?}", ran.steps);
    assert_ne!(ran.job_state, "completed");
    let record = navigate(&ran);
    assert_eq!(record.decision, "deny");
    assert_eq!(
        record.reason.as_deref(),
        Some("host_error:approval_unresolved")
    );
    // Nothing the run raised stays answerable.
    let seen = mock.seen.lock().unwrap();
    assert_eq!((seen.revokes, seen.cancels.len()), (1, 1));
    assert_eq!(seen.spends, 0);
}

#[tokio::test]
async fn an_approval_bound_to_some_other_request_is_not_an_approval() {
    // The server reports, and later attests, a digest over other content: the
    // person approved something, but not this.
    let mock = serve(Mode::Approve, true).await;
    let world = world_asking(&mock, &escalate("navigate"), Some(APPROVER), "30").await;
    let ran = rotate(&world, &mock, false, || async {}).await;

    assert!(ran.steps.is_empty(), "{:?}", ran.steps);
    assert_ne!(ran.job_state, "completed");
    let record = navigate(&ran);
    assert_eq!(record.decision, "deny");
    assert_eq!(
        record.reason.as_deref(),
        Some("opensesame:approval_not_bound"),
        "the denial says the approval was for something else"
    );
}

#[tokio::test]
async fn an_organization_nobody_is_named_for_is_never_asked() {
    let mock = serve(Mode::Approve, false).await;
    // Configured deployment, no approver for the organization, no default.
    let world = world_asking(&mock, &escalate("navigate"), None, "30").await;
    let ran = rotate(&world, &mock, false, || async {}).await;

    assert!(ran.steps.is_empty(), "{:?}", ran.steps);
    assert_eq!(navigate(&ran).decision, "deny");
    let seen = mock.seen.lock().unwrap();
    assert_eq!(
        (
            seen.auth_requests.len(),
            seen.interactions.len(),
            seen.consumes
        ),
        (0, 0, 0),
        "no request ever left the Host"
    );
}

#[tokio::test]
async fn a_deployment_with_no_approver_leaves_every_escalation_a_denial() {
    let mock = serve(Mode::Approve, false).await;
    let mut world = world_asking(&mock, &escalate("navigate"), Some(APPROVER), "30").await;
    world.state.agent_hook_approver = None;
    let ran = rotate(&world, &mock, false, || async {}).await;

    assert!(ran.steps.is_empty(), "{:?}", ran.steps);
    assert_eq!(navigate(&ran).decision, "deny");
    assert_eq!(mock.seen.lock().unwrap().auth_requests.len(), 0);
}

#[tokio::test]
async fn only_the_escalated_verb_waits_and_the_others_are_not_asked_about() {
    let mock = serve(Mode::Approve, false).await;
    let world = world_asking(&mock, &escalate("submit"), Some(APPROVER), "30").await;
    let ran = rotate(&world, &mock, false, || async {}).await;

    assert_eq!(ran.steps, COMPLETE_RUN);
    let seen = mock.seen.lock().unwrap();
    assert_eq!(seen.interactions.len(), 1, "only `submit` escalated");
    let detail: &Value = &seen.interactions[0]["authorizationDetails"][0];
    assert_eq!(detail["locations"], json!(["submit"]));
}
