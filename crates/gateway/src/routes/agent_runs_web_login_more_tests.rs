//! The hosted web-login run's other edges: a secret a driver settled, the
//! default policy with no approver, and a job with no way through.

use std::sync::atomic::{AtomicBool, Ordering};

use opensesame_rotation_web::hooks::{HostInput, InputRole, ShutdownReason, BROWSER_VERBS};
use opensesame_rotation_web::BrowserTransport;

use super::*;
use crate::web_login::prepare::{prepare, DEFER_NO_RECIPE};
use crate::web_login::Harness;

fn secret() -> String {
    format!("ghp_{}", "x".repeat(36))
}

/// A driver that answers a DOM read with a credential in it — in the text,
/// and in a field no outcome has.
fn leaky(request: &Value) -> Value {
    if request["step"] == "read_dom_redacted" {
        let secret = secret();
        return json!({
            "outcome": "dom",
            "text": format!("<p>your token is {secret}</p>"),
            "epoch": 1,
            "note": secret,
        });
    }
    happy(request)
}

/// A driver that reaches the queue by a road the outcome route does not guard
/// — an older gateway process, another writer: it claims through the route and
/// settles straight into the table. The executor's own guard is what is left,
/// and this is how it is still exercised.
async fn drive_past_the_route(
    f: &Fixture,
    done: &AtomicBool,
    answer: fn(&Value) -> Value,
) -> Drive {
    let mut log = Drive::default();
    while !done.load(Ordering::SeqCst) {
        let runs = f.state.db.list_observation_runs(&f.org, 10).await.unwrap();
        for run in runs.iter().filter(|run| run.closed_at.is_none()) {
            let claim = format!("/api/v1/agent/runs/{}/steps/claim", run.id);
            let (status, claimed) = f.browser.send(&f.app, "POST", &claim, None).await;
            if status != StatusCode::OK {
                continue;
            }
            let seq = claimed["seq"].as_i64().unwrap();
            let step = f
                .state
                .db
                .get_runner_step(&f.org, &run.id, seq)
                .await
                .unwrap()
                .unwrap();
            let outcome = answer(&claimed["request"]).to_string();
            let held = step.claimed_by.unwrap();
            let now = Utc::now().to_rfc3339();
            f.state
                .db
                .settle_runner_step(&f.org, &run.id, seq, &held, &outcome, &now)
                .await
                .unwrap();
            log.claimed.push(claimed.clone());
            log.bodies.push(claimed);
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    log
}

#[tokio::test]
async fn a_secret_that_reaches_the_queue_unscrubbed_is_still_redacted_before_the_executor_or_the_record(
) {
    let f = fixture().await;
    prerequisites(&f, Some(r#"{"version":1,"unlisted_tools":"allow"}"#)).await;
    let org = opensesame_domain::OrganizationId::parse(&f.org).unwrap();
    let plan = prepare(&f.state.db, &org, SITE, Some(ALICE)).await.unwrap();
    let launcher = launcher(&f);
    let harness = Harness::open(&launcher, &plan, "run_leak", "rot_leak")
        .await
        .unwrap();
    let session = harness.hooked.session();
    session.startup(&BROWSER_VERBS).await.unwrap();
    session
        .input(&HostInput {
            content: json!({"run": "change_password", "recipe": plan.recipe_id, "origin": SITE}),
            role: InputRole::System,
        })
        .await
        .unwrap();

    let done = AtomicBool::new(false);
    let (dom, log) = tokio::join!(
        async {
            let dom = harness.hooked.read_dom_redacted().await;
            done.store(true, Ordering::SeqCst);
            dom
        },
        drive_past_the_route(&f, &done, leaky),
    );
    session.shutdown(ShutdownReason::Completed).await;
    harness.channel.flush_records().await.unwrap();

    // What the executor reads: the text, with the credential replaced.
    let dom = dom.expect("a redacted read is still a read");
    assert!(!dom.text().contains(&secret()), "{}", dom.text());
    assert!(dom.text().contains("[redacted:"), "{}", dom.text());

    // The record says a transform happened, and carries none of it.
    let records = f
        .state
        .db
        .agent_hook_records(&f.org, "run_leak")
        .await
        .unwrap();
    let post = records
        .iter()
        .find(|r| r.interception_point == "post_tool_call")
        .expect("the read was recorded");
    assert_eq!(post.decision, "transform");
    assert_eq!(post.reason.as_deref(), Some("opensesame:secret_redacted"));
    assert!(!format!("{records:?}").contains(&secret()));

    // The queue row the driver wrote no longer holds it either.
    let rows = queue(&f, "run_leak").await;
    let stored = rows[0].1.clone().unwrap_or_default();
    assert!(!stored.contains(&secret()), "{stored}");
    // And nothing any route answered the driver with carried it.
    for body in &log.bodies {
        assert!(!body.to_string().contains(&secret()), "{body}");
    }
}

#[tokio::test]
async fn with_no_approver_the_default_policy_refuses_the_first_verb() {
    let f = fixture().await;
    // No stored hook policy: every tool escalates, and with no approval
    // resolver an escalation is a denial (agent-hooks §9).
    let policy = prerequisites(&f, None).await;
    let (outcome, log) = rotate_driven(&f, policy, happy).await;
    assert!(!outcome.succeeded);
    assert!(log.claimed.is_empty(), "no step ever reached the driver");

    let (run_id, records) = the_run(&f).await;
    assert!(queue(&f, &run_id).await.is_empty());
    assert_eq!(
        points(&records),
        [
            "agent_startup",
            "input",
            "pre_tool_call",
            "output",
            "agent_shutdown"
        ]
    );
    assert!(records[2].escalated);
    assert_eq!(
        records[2].reason.as_deref(),
        Some("opensesame:tool_requires_approval")
    );
    assert!(records.iter().all(|r| r.policy_version == 0));
    let job = &f
        .state
        .connection_broker
        .list_rotation_jobs(&f.org, 10)
        .await
        .unwrap()[0];
    let detail = job.detail.clone().unwrap_or_default();
    assert!(detail.starts_with("not submitted"), "{detail}");
}

#[tokio::test]
async fn a_rotation_with_no_recipe_parks_through_the_lifecycle_responder() {
    let f = fixture().await;
    let policy = f
        .state
        .connection_broker
        .upsert_rotation_policy(
            &f.org,
            opensesame_connection_broker::UpsertRotationPolicy {
                id: None,
                target: opensesame_connection_broker::RotationTarget::WebLogin {
                    origin: SITE.into(),
                },
                owner_subject: Some(ALICE.into()),
                interval_seconds: 86_400,
                enabled: true,
            },
        )
        .await
        .unwrap();

    let outcome = crate::lifecycle::responders::respond(&f.state, &event(&f)).await;
    assert!(!outcome.succeeded, "{}", outcome.detail);
    assert!(
        outcome.detail.contains(DEFER_NO_RECIPE),
        "{}",
        outcome.detail
    );

    let job = &f
        .state
        .connection_broker
        .list_rotation_jobs(&f.org, 10)
        .await
        .unwrap()[0];
    assert_eq!(job.state, "reconciliation_required");
    assert_eq!(job.detail.as_deref(), Some(DEFER_NO_RECIPE));
    assert!(f
        .state
        .db
        .list_observation_runs(&f.org, 10)
        .await
        .unwrap()
        .is_empty());

    // The policy backs off rather than reporting a rotation that did not
    // happen; the next claim must wait.
    let stored = f
        .state
        .connection_broker
        .list_rotation_policies(&f.org)
        .await
        .unwrap();
    let stored = stored.iter().find(|p| p.id == policy.id).unwrap();
    assert_eq!(stored.attempts, 1);
    assert!(stored.last_rotated_at.is_none());
}

#[tokio::test]
async fn a_driver_that_never_answers_parks_the_run_and_its_step_goes_stale() {
    let f = fixture().await;
    let policy = prerequisites(&f, Some(r#"{"version":1,"unlisted_tools":"allow"}"#)).await;
    let org = opensesame_domain::OrganizationId::parse(&f.org).unwrap();
    let quiet = WebLoginLauncher::new(f.state.clone(), None).with_timing(RunTiming {
        step_deadline: std::time::Duration::from_millis(50),
        poll: std::time::Duration::from_millis(5),
        run_deadline: std::time::Duration::from_secs(10),
    });
    let outcome = quiet.rotate(&event(&f), SITE, &org, Some(policy)).await;
    assert!(!outcome.succeeded);

    let (run_id, _) = the_run(&f).await;
    let rows = queue(&f, &run_id).await;
    assert_eq!(
        rows.len(),
        1,
        "one step, never settled, and nothing after it"
    );
    assert_eq!(rows[0].0["step"], "navigate");
    assert!(rows[0].1.is_none());
    let job = &f
        .state
        .connection_broker
        .list_rotation_jobs(&f.org, 10)
        .await
        .unwrap()[0];
    let detail = job.detail.clone().unwrap_or_default();
    assert!(
        detail.contains("the sandbox runner could not act"),
        "{detail}"
    );

    // The run is closed, so the step it left behind can no longer be taken.
    let claim = format!("/api/v1/agent/runs/{run_id}/steps/claim");
    let (status, _) = f.browser.send(&f.app, "POST", &claim, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn a_driver_answering_after_the_run_stopped_stores_nothing() {
    let f = fixture().await;
    let policy = prerequisites(&f, Some(r#"{"version":1,"unlisted_tools":"allow"}"#)).await;
    let org = opensesame_domain::OrganizationId::parse(&f.org).unwrap();
    let quiet = WebLoginLauncher::new(f.state.clone(), None).with_timing(RunTiming {
        step_deadline: std::time::Duration::from_millis(200),
        poll: std::time::Duration::from_millis(5),
        run_deadline: std::time::Duration::from_secs(10),
    });
    // Claim the first step as soon as it is queued, then sit on it.
    let claimer = claim_when_queued(&f);
    let due = event(&f);
    let (outcome, (run_id, seq)) =
        tokio::join!(quiet.rotate(&due, SITE, &org, Some(policy)), claimer);
    assert!(!outcome.succeeded);

    // The executor stopped waiting and closed the run; the late answer, with
    // a credential in it, is refused rather than left in the queue.
    let settle = format!("/api/v1/agent/runs/{run_id}/steps/{seq}/outcome");
    // A well-formed answer is refused because the run is closed; one with a
    // field the outcome does not have is refused as malformed. Either way the
    // credential is not stored and not echoed.
    let body = json!({"outcome": {"outcome": "done"}});
    let (status, _) = f.browser.send(&f.app, "POST", &settle, Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let body = json!({"outcome": {"outcome": "done", "note": secret()}});
    let (status, refused) = f.browser.send(&f.app, "POST", &settle, Some(body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!refused.to_string().contains(&secret()), "{refused}");
    let rows = queue(&f, &run_id).await;
    assert!(
        rows.iter().all(|(_, outcome)| outcome.is_none()),
        "{rows:?}"
    );
}

/// Poll until the open run has a step queued, claim it, and hold the claim.
async fn claim_when_queued(f: &Fixture) -> (String, i64) {
    for _ in 0..400 {
        if let Some(claimed) = claim_first(f).await {
            return claimed;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the run never queued a step");
}

/// Claim the open run's outstanding step, if one is queued yet.
async fn claim_first(f: &Fixture) -> Option<(String, i64)> {
    let runs = f.state.db.list_observation_runs(&f.org, 10).await.unwrap();
    let run = runs.first()?;
    let claim = format!("/api/v1/agent/runs/{}/steps/claim", run.id);
    let (status, claimed) = f.browser.send(&f.app, "POST", &claim, None).await;
    (status == StatusCode::OK).then(|| (run.id.clone(), claimed["seq"].as_i64().unwrap()))
}
