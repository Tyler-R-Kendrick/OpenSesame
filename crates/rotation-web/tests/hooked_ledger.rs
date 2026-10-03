//! A refused ledger read in a hosted capture run (agent-hooks/0.1 §6.2,
//! §13.1 `tool_seam_host_error: terminate`).
//!
//! `outstanding()` cannot return an error, so a refused call answers every
//! slot — the direction that never reads as a finished ceremony. That answer
//! is a refusal, not the ledger, and it must not become the run's report: a
//! report listing sealed slots as outstanding would have the caller ask for
//! them again. The declared posture is that a refused verb ends the run, so
//! the hosted run fails.

mod hooks_support;

use agent_hooks::Verdict;
use hooks_support::{at, point, session, FakeBrowser, Scripted};
use opensesame_ceremony::Slot;
use opensesame_rotation_web::hooks::{HostedRunError, RunKind, RunRequest};
use opensesame_rotation_web::{
    run_capture_steps_hooked, CaptureError, CaptureStep, CeremonyTransport, HookedTransport,
    StepError,
};

fn request() -> RunRequest {
    RunRequest {
        run: RunKind::Capture,
        recipe: "github-app".into(),
        origin: "https://github.com".into(),
    }
}

fn steps() -> [CaptureStep; 1] {
    [CaptureStep::Field {
        slot: Slot::ClientId,
        selector: "#id".into(),
    }]
}

fn refusing_ledger_at(wanted: &'static str) -> Scripted {
    Scripted::new(move |c| {
        if at(c, wanted, Some("outstanding")) {
            Verdict::deny(Some("acme:no_ledger".into()), None)
        } else {
            Verdict::allow()
        }
    })
}

#[tokio::test]
async fn a_refused_ledger_read_fails_the_capture_run_at_either_seam() {
    for wanted in ["pre_tool_call", "post_tool_call"] {
        let interceptor = refusing_ledger_at(wanted);
        let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
        let outcome = run_capture_steps_hooked(&hooked, &steps(), &request()).await;
        assert_eq!(
            outcome,
            Err(HostedRunError::Run(CaptureError::Step(StepError::Refused))),
            "{wanted}"
        );
        assert!(hooked.ledger_refused(), "{wanted}");
        let seen = interceptor.seen();
        assert!(
            !seen.iter().any(|c| point(c) == "output"),
            "{wanted}: no report is emitted for a run that did not finish"
        );
        assert_eq!(seen.last().unwrap()["summary"]["reason"], "error");
        let refusal = hooked.session().last_refusal().await.unwrap();
        assert_eq!(refusal.reason.as_deref(), Some("acme:no_ledger"));
    }
}

#[tokio::test]
async fn a_refused_ledger_read_still_answers_every_slot_to_a_direct_caller() {
    let interceptor = refusing_ledger_at("pre_tool_call");
    let hooked = hooks_support::opened(FakeBrowser::default(), &interceptor).await;
    assert!(!hooked.ledger_refused());
    assert_eq!(hooked.outstanding().await, Slot::ALL.to_vec());
    assert!(hooked.ledger_refused());
    assert!(
        hooked.inner().calls().is_empty(),
        "the ledger was never read"
    );
}

#[tokio::test]
async fn an_allowed_ledger_read_is_the_report() {
    let interceptor = Scripted::allow_all();
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    let report = run_capture_steps_hooked(&hooked, &steps(), &request())
        .await
        .unwrap();
    assert!(report.is_complete());
    assert!(!hooked.ledger_refused());
}
