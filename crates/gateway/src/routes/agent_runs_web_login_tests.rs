//! A web-login rotation, hooked end to end, driven through the real step
//! routes the way the owner's browser extension would drive it (ADR 0076,
//! ADR 0159).
//!
//! The fake driver below knows nothing the extension would not: it lists the
//! owner's runs, claims each step over `POST …/steps/claim`, and settles it
//! over `POST …/steps/{seq}/outcome`. Every body the Host answers it with is
//! kept, so the tests can say what never came back.

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use opensesame_agent_hooks::secrets;
use opensesame_connection_broker::{RotationPolicy, RotationTarget, UpsertRotationPolicy};
use opensesame_lifecycle::{ExpiryStage, ExpirySubject, LifecycleEvent, SubjectKind};
use opensesame_storage::agent_hook_policy::{AgentHookPolicyAudit, AgentHookPolicyWrite};
use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use serde_json::json;
use sqlx::Row;

use super::support::Fixture;
use super::*;
use crate::web_login::{RunTiming, WebLoginLauncher};

#[path = "agent_runs_web_login_more_tests.rs"]
mod more;

pub(super) const SITE: &str = "https://login.example";
/// Every verb a completed change-password run hands the browser, in order.
const BROWSER_STEPS: [&str; 8] = [
    "navigate",
    "wait_for",
    "fill_credential",
    "fill_credential",
    "fill_credential",
    "assert_present",
    "submit",
    "verify_login",
];

/// Seed what a run needs: a policy owned by Alice, a verified recipe, and
/// the organization's hook policy.
pub(super) async fn prerequisites(f: &Fixture, hook_policy: Option<&str>) -> RotationPolicy {
    crate::web_login::recipe_fixture::seed(&f.state.db, &f.org, SITE, true).await;
    if let Some(policy) = hook_policy {
        f.state
            .db
            .put_agent_hook_policy(
                &AgentHookPolicyWrite {
                    organization_id: &f.org,
                    policy_json: policy,
                    expected_version: 0,
                    updated_by: "operator",
                },
                &AgentHookPolicyAudit {
                    event_type: "agent_hooks.policy.updated",
                    payload_json: "{}",
                },
            )
            .await
            .unwrap();
    }
    f.state
        .connection_broker
        .upsert_rotation_policy(
            &f.org,
            UpsertRotationPolicy {
                id: None,
                target: RotationTarget::WebLogin {
                    origin: SITE.into(),
                },
                owner_subject: Some(ALICE.into()),
                interval_seconds: 86_400,
                enabled: true,
            },
        )
        .await
        .unwrap()
}

pub(super) fn event(f: &Fixture) -> LifecycleEvent {
    let now = Utc::now();
    LifecycleEvent::for_stage(
        ExpirySubject {
            kind: SubjectKind::WebLogin,
            subject_id: SITE.into(),
            organization_id: f.org.clone(),
            expires_at: now,
            renew_before_seconds: Some(1),
            auto_respond: true,
            alerting: false,
            label: None,
        },
        ExpiryStage::Renewal,
        now,
    )
}

pub(super) fn launcher(f: &Fixture) -> WebLoginLauncher {
    WebLoginLauncher::new(f.state.clone(), None).with_timing(RunTiming {
        step_deadline: std::time::Duration::from_secs(20),
        poll: std::time::Duration::from_millis(5),
        run_deadline: std::time::Duration::from_secs(60),
    })
}

/// What a well-behaved extension settles for each step.
pub(super) fn happy(request: &Value) -> Value {
    match request["step"].as_str().unwrap_or_default() {
        "fill_credential" => json!({"outcome": "filled", "filled": "Ok"}),
        "assert_present" => json!({"outcome": "presence", "presence": "Present"}),
        "verify_login" => json!({"outcome": "verified", "verified": "Works"}),
        "seal_candidate" => json!({"outcome": "sealed", "backed_up": true}),
        _ => json!({"outcome": "done"}),
    }
}

/// Everything the driver sent and was sent.
#[derive(Default)]
pub(super) struct Drive {
    pub claimed: Vec<Value>,
    pub bodies: Vec<Value>,
}

/// Drive every open run of Alice's until `done`.
pub(super) async fn drive(f: &Fixture, done: &AtomicBool, answer: fn(&Value) -> Value) -> Drive {
    let mut log = Drive::default();
    while !done.load(Ordering::SeqCst) {
        let (status, listed) = f
            .browser
            .send(&f.app, "GET", "/api/v1/agent/runs", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        let open: Vec<String> = listed["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|run| run["closed_at"].is_null())
            .filter_map(|run| run["id"].as_str().map(str::to_owned))
            .collect();
        log.bodies.push(listed);
        let mut acted = false;
        for run in open {
            let claim = format!("/api/v1/agent/runs/{run}/steps/claim");
            let (status, claimed) = f.browser.send(&f.app, "POST", &claim, None).await;
            if status == StatusCode::NO_CONTENT {
                continue;
            }
            assert_eq!(status, StatusCode::OK, "{claimed}");
            let seq = claimed["seq"].as_i64().unwrap();
            let settle = format!("/api/v1/agent/runs/{run}/steps/{seq}/outcome");
            let body = json!({"outcome": answer(&claimed["request"])});
            let (status, settled) = f.browser.send(&f.app, "POST", &settle, Some(body)).await;
            assert_eq!(status, StatusCode::OK, "{settled}");
            log.claimed.push(claimed.clone());
            log.bodies.extend([claimed, settled]);
            acted = true;
        }
        if !acted {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
    log
}

/// Run the lifecycle's rotation with the fake extension driving it.
pub(super) async fn rotate_driven(
    f: &Fixture,
    policy: RotationPolicy,
    answer: fn(&Value) -> Value,
) -> (crate::lifecycle::responders::Outcome, Drive) {
    let done = AtomicBool::new(false);
    let org = opensesame_domain::OrganizationId::parse(&f.org).unwrap();
    let event = event(f);
    let launcher = launcher(f);
    tokio::join!(
        async {
            let outcome = launcher.rotate(&event, SITE, &org, Some(policy)).await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(f, &done, answer),
    )
}

/// The same, through the production entry: the lifecycle responder, with the
/// launcher it builds for itself (default clock, no approval resolver).
async fn respond_driven(f: &Fixture) -> (crate::lifecycle::responders::Outcome, Drive) {
    let done = AtomicBool::new(false);
    let event = event(f);
    tokio::join!(
        async {
            let outcome = crate::lifecycle::responders::respond(&f.state, &event).await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(f, &done, happy),
    )
}

/// The single run the rotation opened, and its hook records.
pub(super) async fn the_run(f: &Fixture) -> (String, Vec<StoredAgentHookRecord>) {
    let runs = f.state.db.list_observation_runs(&f.org, 10).await.unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert!(runs[0].closed_at.is_some(), "a finished run is closed");
    let records = f
        .state
        .db
        .agent_hook_records(&f.org, &runs[0].id)
        .await
        .unwrap();
    (runs[0].id.clone(), records)
}

/// The queue's rows for a run: `(request, outcome)`.
pub(super) async fn queue(f: &Fixture, run_id: &str) -> Vec<(Value, Option<String>)> {
    sqlx::query("SELECT organization_id, seq, request_json, outcome_json FROM runner_steps WHERE run_id = ? ORDER BY seq")
        .bind(run_id)
        .fetch_all(f.state.db.pool())
        .await
        .unwrap()
        .iter()
        .map(|row| {
            // Sealed at rest once the process-wide sealer is installed (ADR 0157).
            let organization: String = row.get("organization_id");
            let record = format!("{run_id}:{}", row.get::<i64, _>("seq"));
            let request: String = row.get("request_json");
            let request =
                opensesame_event_seal::open_in(&organization, "runner_steps.request_json", &record, &request).unwrap();
            let outcome = row.get::<Option<String>, _>("outcome_json")
                .map(|outcome| opensesame_event_seal::open_in(&organization, "runner_steps.outcome_json", &record, &outcome))
                .transpose().unwrap();
            (serde_json::from_str(&request).unwrap(), outcome)
        })
        .collect()
}

pub(super) fn points(records: &[StoredAgentHookRecord]) -> Vec<&str> {
    records
        .iter()
        .map(|record| record.interception_point.as_str())
        .collect()
}

#[tokio::test]
async fn a_rotation_runs_hooked_end_to_end_and_returns_nothing_credential_valued() {
    let f = fixture().await;
    prerequisites(&f, Some(r#"{"version":1,"unlisted_tools":"allow"}"#)).await;
    let (outcome, log) = respond_driven(&f).await;
    assert!(outcome.succeeded, "{}", outcome.detail);

    let (run_id, records) = the_run(&f).await;
    let jobs = f
        .state
        .connection_broker
        .list_rotation_jobs(&f.org, 10)
        .await
        .unwrap();
    assert_eq!(jobs[0].state, "completed", "{:?}", jobs[0]);

    // (a) startup, input, every verb bracketed, output, shutdown — in order.
    let mut expected = vec!["agent_startup", "input"];
    for _ in BROWSER_STEPS {
        expected.extend(["pre_tool_call", "post_tool_call"]);
    }
    expected.extend(["output", "agent_shutdown"]);
    assert_eq!(points(&records), expected);
    let sequences: Vec<i64> = records.iter().map(|r| r.sequence).collect();
    assert!(sequences.windows(2).all(|w| w[0] < w[1]), "{sequences:?}");
    assert!(records
        .iter()
        .all(|r| r.decision == "allow" && r.policy_version == 1));

    // The queue carried exactly the browser's verbs plus the vault's custody
    // steps, and nothing a value could sit in.
    let rows = queue(&f, &run_id).await;
    let steps: Vec<&str> = rows
        .iter()
        .map(|(r, _)| r["step"].as_str().unwrap())
        .collect();
    let browser: Vec<&str> = steps
        .iter()
        .copied()
        .filter(|s| !s.ends_with("_candidate"))
        .collect();
    assert_eq!(browser, BROWSER_STEPS);
    let custody = ["generate_candidate", "seal_candidate", "promote_candidate"];
    assert_eq!(
        steps
            .iter()
            .filter(|s| s.ends_with("_candidate"))
            .copied()
            .collect::<Vec<_>>(),
        custody
    );
    for (request, _) in &rows {
        if let Some(reference) = request.get("reference").and_then(Value::as_str) {
            assert!(
                reference == "current_password" || reference.starts_with("candidate:"),
                "{reference}"
            );
        }
    }

    // (d) Nothing any route answered — list, claim, settle, the run, its log,
    // the job — carries a credential shape or a value field.
    let mut bodies = log.bodies;
    for uri in [
        format!("/api/v1/agent/runs/{run_id}"),
        format!("/api/v1/agent/runs/{run_id}/log"),
    ] {
        let (status, body) = f.browser.send(&f.app, "GET", &uri, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        bodies.push(body);
    }
    let job_uri = format!("/api/v1/rotations/{}", jobs[0].id);
    let (status, job) = send_json(&f.app, &f.alice, "GET", &job_uri, None).await;
    assert_eq!(status, StatusCode::OK, "{job}");
    bodies.push(job);
    for body in &bodies {
        assert!(secrets::scan(body).is_empty(), "{body}");
        for field in [
            "password",
            "value",
            "secret",
            "plaintext",
            "candidate_value",
        ] {
            assert!(body.get(field).is_none(), "{field} in {body}");
        }
    }
    assert!(log
        .claimed
        .iter()
        .all(|claimed| claimed["secrets_returned"] == json!(false)));
}

#[tokio::test]
async fn a_denied_verb_stops_the_run_before_it_is_ever_enqueued() {
    let f = fixture().await;
    let policy = prerequisites(
        &f,
        Some(
            r#"{"version":1,"unlisted_tools":"allow",
                "tools":[{"name":"submit","decision":"deny"}]}"#,
        ),
    )
    .await;
    let (outcome, _) = rotate_driven(&f, policy, happy).await;
    assert!(!outcome.succeeded);

    let (run_id, records) = the_run(&f).await;
    let rows = queue(&f, &run_id).await;
    assert!(
        rows.iter().all(|(r, _)| r["step"] != "submit"),
        "the refused submit never reached the queue"
    );
    let denied: Vec<_> = records.iter().filter(|r| r.decision == "deny").collect();
    assert_eq!(denied.len(), 1, "{records:?}");
    assert_eq!(denied[0].interception_point, "pre_tool_call");
    assert_eq!(denied[0].reason.as_deref(), Some("opensesame:tool_denied"));
    assert_eq!(points(&records).last(), Some(&"agent_shutdown"));

    // Nothing was submitted, so the previous password stands, and the job
    // says so rather than asking a person to reconcile a change never sent.
    let job = &f
        .state
        .connection_broker
        .list_rotation_jobs(&f.org, 10)
        .await
        .unwrap()[0];
    assert_eq!(job.state, "reconciliation_required");
    let detail = job.detail.clone().unwrap_or_default();
    assert!(detail.starts_with("not submitted"), "{detail}");
    assert!(
        detail.contains("opensesame:tool_denied at pre_tool_call"),
        "{detail}"
    );
}
