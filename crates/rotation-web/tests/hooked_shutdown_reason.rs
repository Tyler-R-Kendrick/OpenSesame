//! `agent_shutdown`'s `summary.reason` follows how the run ended (§4.2): a
//! refused step is an `error`, a run that stood down for a person is
//! `cancelled`, and neither is recorded as `completed`.

mod hooks_support;

use agent_hooks::Verdict;
use hooks_support::{at, recipe, session, FakeBrowser, FakeVault, Scripted};
use opensesame_rotation_web::hooks::{RunKind, RunRequest};
use opensesame_rotation_web::{
    run_change_password_hooked, BlockedReason, CredentialRef, HookedTransport, RunOutcome,
    StepError,
};
use opensesame_session_observe::ControlLease;

async fn rotate(hooked: &HookedTransport<FakeBrowser>) -> RunOutcome {
    let request = RunRequest {
        run: RunKind::ChangePassword,
        recipe: "example".into(),
        origin: "https://example.com".into(),
    };
    run_change_password_hooked(
        hooked,
        &FakeVault,
        &recipe(),
        &CredentialRef::new("conn:example"),
        ControlLease::new(),
        &request,
    )
    .await
    .expect("the run reports")
    .outcome
}

#[tokio::test]
async fn a_hook_refused_run_is_an_error_shutdown_not_a_completed_one() {
    let interceptor = Scripted::new(|c| {
        if at(c, "pre_tool_call", Some("navigate")) {
            Verdict::deny(Some("acme:origin_not_allowed".into()), None)
        } else {
            Verdict::allow()
        }
    });
    let hooked = HookedTransport::new(FakeBrowser::default(), session(&interceptor));
    assert_eq!(
        rotate(&hooked).await,
        RunOutcome::Blocked(BlockedReason::HookRefused)
    );
    let seen = interceptor.seen();
    assert_eq!(seen.last().unwrap()["summary"]["reason"], "error");
}

#[tokio::test]
async fn a_run_the_page_could_not_continue_is_an_error_shutdown() {
    let interceptor = Scripted::allow_all();
    let browser = FakeBrowser {
        wait_error: Some(StepError::Timeout),
        ..FakeBrowser::default()
    };
    let hooked = HookedTransport::new(browser, session(&interceptor));
    assert_eq!(
        rotate(&hooked).await,
        RunOutcome::Blocked(BlockedReason::RecipeDrift)
    );
    assert_eq!(
        interceptor.seen().last().unwrap()["summary"]["reason"],
        "error"
    );
}

#[tokio::test]
async fn a_run_that_stood_down_for_a_person_is_a_cancelled_shutdown() {
    let interceptor = Scripted::allow_all();
    let browser = FakeBrowser {
        wait_error: Some(StepError::Transport),
        ..FakeBrowser::default()
    };
    // The host's channel parked the run for a person; the executor only saw a
    // step it could not take.
    let session = session(&interceptor).with_stand_down(|| true);
    let hooked = HookedTransport::new(browser, session);
    assert!(matches!(rotate(&hooked).await, RunOutcome::Blocked(_)));
    assert_eq!(
        interceptor.seen().last().unwrap()["summary"]["reason"],
        "cancelled"
    );
}
