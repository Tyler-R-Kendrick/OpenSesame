//! A whole run as one agent-hooks session (ADR 0150; agent-hooks/0.1 §3.1,
//! §6, §6.1a, §9), driven through the production entry points
//! `run_change_password_hooked` and `run_capture_steps_hooked`.

mod hooks_support;

use agent_hooks::{ApprovalOutcome, Verdict};
use hooks_support::{
    at, point, points_of, recipe, session, session_resolving, transform, wire, Answering,
    FakeBrowser, FakeVault, Scripted,
};
use opensesame_ceremony::Slot;
use opensesame_rotation_web::hooks::{HostedRunError, RunKind, RunRequest, BROWSER_VERBS};
use opensesame_rotation_web::{
    run_capture_steps_hooked, run_change_password_hooked, ActionStep, BlockedReason, CaptureError,
    CaptureStep, CredentialRef, HookedTransport, RunOutcome, StepError,
};
use opensesame_session_observe::ControlLease;
use serde_json::json;

fn request() -> RunRequest {
    RunRequest {
        run: RunKind::ChangePassword,
        recipe: "example".into(),
        origin: "https://example.com".into(),
    }
}

fn current() -> CredentialRef {
    CredentialRef::new("conn:example")
}

async fn rotate(
    hooked: &HookedTransport<FakeBrowser>,
) -> Result<
    opensesame_rotation_web::RunReport,
    HostedRunError<opensesame_rotation_web::ExecutorError>,
> {
    run_change_password_hooked(
        hooked,
        &FakeVault,
        &recipe(),
        &current(),
        ControlLease::new(),
        &request(),
    )
    .await
}

#[tokio::test]
async fn a_rotation_is_startup_input_verbs_output_shutdown_in_that_order() {
    let interceptor = Scripted::allow_all();
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let report = rotate(&hooked).await.unwrap();
    assert_eq!(report.outcome, RunOutcome::Completed);

    let seen = interceptor.seen();
    assert_eq!(point(&seen[0]), "agent_startup");
    assert_eq!(
        seen[0]["agent_init"]["tools_registered"],
        json!(BROWSER_VERBS)
    );
    assert_eq!(point(&seen[1]), "input");
    assert_eq!(seen[1]["input"]["role"], "system");
    assert_eq!(
        seen[1]["input"]["content"],
        json!({
            "run": "change_password", "recipe": "example", "origin": "https://example.com"
        })
    );
    let last = seen.len() - 1;
    assert_eq!(point(&seen[last - 1]), "output");
    assert_eq!(seen[last - 1]["output"]["content"]["outcome"], "completed");
    assert_eq!(point(&seen[last]), "agent_shutdown");
    assert_eq!(seen[last]["summary"]["reason"], "completed");
    // The ordering the executor owns is untouched by the wrapper.
    assert_eq!(
        hooked.inner().verbs(),
        [
            "navigate",
            "wait_for",
            "fill_credential",
            "fill_credential",
            "assert_present",
            "submit",
            "verify_login"
        ]
    );
    let records = hooked.session().records().await;
    assert_eq!(records.len(), seen.len(), "one record per emission");
    let sequences: Vec<i64> = records.iter().map(|r| r.sequence).collect();
    assert_eq!(sequences, (0..).take(records.len()).collect::<Vec<i64>>());
}

#[tokio::test]
async fn a_startup_deny_processes_nothing_and_still_shuts_down_with_error() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "agent_startup" {
            Verdict::deny(Some("acme:not_today".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let Err(HostedRunError::Refused(refusal)) = rotate(&hooked).await else {
        panic!("a denied startup must refuse the run");
    };
    assert_eq!(refusal.reason.as_deref(), Some("acme:not_today"));
    assert!(hooked.inner().calls().is_empty());
    let records = hooked.session().records().await;
    assert_eq!(points_of(&records), ["agent_startup", "agent_shutdown"]);
    assert_eq!(interceptor.seen()[1]["summary"]["reason"], "error");
}

#[tokio::test]
async fn an_input_deny_means_the_turn_never_begins() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "input" {
            Verdict::deny(Some("acme:origin_blocked".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    assert!(matches!(
        rotate(&hooked).await,
        Err(HostedRunError::Refused(_))
    ));
    assert!(hooked.inner().calls().is_empty());
    let records = hooked.session().records().await;
    assert_eq!(
        points_of(&records),
        ["agent_startup", "input", "agent_shutdown"]
    );
}

#[tokio::test]
async fn an_input_transform_that_changes_the_request_is_refused() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "input" {
            transform("$target.content.origin", json!("https://elsewhere.example"))
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let Err(HostedRunError::Refused(refusal)) = rotate(&hooked).await else {
        panic!("a request this host cannot run must not start a turn");
    };
    assert_eq!(
        refusal.reason.as_deref(),
        Some("host_error:transform_invalid")
    );
    assert!(hooked.inner().calls().is_empty());
}

#[tokio::test]
async fn a_refused_fill_blocks_the_rotation_before_anything_is_submitted() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("fill_credential")) {
            Verdict::deny(Some("opensesame:tool_denied".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let report = rotate(&hooked).await.unwrap();
    assert_eq!(
        report.outcome,
        RunOutcome::Blocked(BlockedReason::HookRefused)
    );
    assert!(!hooked.inner().verbs().iter().any(|v| v == "submit"));
    assert!(!report.steps.contains(&ActionStep::Submitted));
}

#[tokio::test]
async fn an_escalated_submit_proceeds_only_when_a_person_approves() {
    let escalate = |c: &agent_hooks::AgentContext| {
        if at(c, "pre_tool_call", Some("submit")) {
            Verdict::escalate(Some("acme:change_window".into()), None)
        } else {
            Verdict::allow()
        }
    };
    let approved = Scripted::new(escalate);
    let resolver = Box::new(Answering(ApprovalOutcome::Approve));
    let hooked = HookedTransport::new(
        FakeBrowser::default(),
        session_resolving(&approved, Some(resolver)),
    );
    assert_eq!(
        rotate(&hooked).await.unwrap().outcome,
        RunOutcome::Completed
    );

    let unresolved = Scripted::new(escalate);
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&unresolved));
    let report = rotate(&hooked).await.unwrap();
    // No resolver: the escalation is a deny (§9). The submit never ran, and
    // the executor reconciles rather than claiming a clean block.
    assert!(matches!(
        report.outcome,
        RunOutcome::ReconciliationRequired(_)
    ));
    assert!(!hooked.inner().verbs().iter().any(|v| v == "submit"));
}

#[tokio::test]
async fn an_output_deny_withholds_the_report_and_closes_with_error() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "output" {
            Verdict::deny(Some("acme:hold".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    // Withheld, not Refused: the rotation ran — the submit reached the site —
    // so a caller must reconcile rather than treat the run as never begun.
    let Err(HostedRunError::Withheld(refusal)) = rotate(&hooked).await else {
        panic!("a report refused at output is withheld, after the run acted");
    };
    assert_eq!(refusal.reason.as_deref(), Some("acme:hold"));
    assert!(hooked.inner().verbs().iter().any(|v| v == "submit"));
    let seen = interceptor.seen();
    assert_eq!(seen.last().unwrap()["summary"]["reason"], "error");
}

#[tokio::test]
async fn an_output_transform_cannot_restate_what_the_run_did() {
    // A completed rotation restated as blocked would have the host keep a
    // password the site no longer accepts. The report is withheld instead.
    let interceptor = Scripted::new(|c| {
        if point(c) == "output" {
            transform("$target.content.outcome", json!({ "blocked": "challenge" }))
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let Err(HostedRunError::Withheld(refusal)) = rotate(&hooked).await else {
        panic!("a transform that rewrites the outcome must not be applied");
    };
    assert_eq!(
        refusal.reason.as_deref(),
        Some("host_error:transform_invalid")
    );
    let records = wire(&hooked.session().records().await);
    let output = records
        .iter()
        .find(|r| r["interception_point"] == "output")
        .unwrap();
    assert_eq!(output["verdict"]["reason"], "host_error:transform_invalid");
    assert!(output
        .get("decided_by")
        .is_none_or(serde_json::Value::is_null));
    assert_eq!(
        records.last().unwrap()["interception_point"],
        "agent_shutdown"
    );
}

#[tokio::test]
async fn an_output_transform_that_leaves_the_report_as_it_was_is_applied() {
    let interceptor = Scripted::new(|c| {
        if point(c) == "output" {
            transform("$target.content.outcome", json!("completed"))
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let report = rotate(&hooked).await.unwrap();
    assert_eq!(report.outcome, RunOutcome::Completed);
    assert_eq!(
        interceptor.seen().last().unwrap()["summary"]["reason"],
        "completed"
    );
}

#[tokio::test]
async fn a_person_holding_the_page_is_a_cancelled_session() {
    let interceptor = Scripted::allow_all();
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let mut lease = ControlLease::new();
    lease.park().unwrap();
    lease.grant_control().unwrap();
    let report = run_change_password_hooked(
        &hooked,
        &FakeVault,
        &recipe(),
        &current(),
        lease,
        &request(),
    )
    .await
    .unwrap();
    assert_eq!(
        report.outcome,
        RunOutcome::Blocked(BlockedReason::HumanDriving)
    );
    assert_eq!(
        interceptor.seen().last().unwrap()["summary"]["reason"],
        "cancelled"
    );
}

#[tokio::test]
async fn a_capture_run_reports_digests_and_a_refused_capture_fails_the_run() {
    let request = RunRequest {
        run: RunKind::Capture,
        recipe: "github-app".into(),
        origin: "https://github.com".into(),
    };
    let steps = [CaptureStep::Field {
        slot: Slot::ClientId,
        selector: "#id".into(),
    }];

    let interceptor = Scripted::allow_all();
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let report = run_capture_steps_hooked(&hooked, &steps, &request)
        .await
        .unwrap();
    assert_eq!(report.sealed.len(), 1);
    assert!(report.is_complete());

    let refusing = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("capture_credential")) {
            Verdict::deny(Some("acme:no_capture".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&refusing));
    let outcome = run_capture_steps_hooked(&hooked, &steps, &request).await;
    assert_eq!(
        outcome,
        Err(HostedRunError::Run(CaptureError::Step(StepError::Refused)))
    );
    let seen = refusing.seen();
    assert!(
        !seen.iter().any(|c| point(c) == "output"),
        "abnormal end: no output"
    );
    assert_eq!(seen.last().unwrap()["summary"]["reason"], "error");
    let records = serde_json::to_string(&wire(&hooked.session().records().await)).unwrap();
    assert!(!records.contains("#id"), "records carry no arguments");
}

#[tokio::test]
async fn a_refused_navigation_is_named_as_a_refusal_not_a_broken_runner() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("navigate")) {
            Verdict::deny(Some("acme:origin_not_allowed".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let report = rotate(&hooked).await.unwrap();
    assert_eq!(
        report.outcome,
        RunOutcome::Blocked(BlockedReason::HookRefused)
    );
    assert!(hooked.inner().calls().is_empty());
}
