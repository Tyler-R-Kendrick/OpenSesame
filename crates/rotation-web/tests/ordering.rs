//! The ordering that must not be rearranged (ADR 0076), proved against a fake
//! browser rather than a real one.
//!
//! The browser is a trait on purpose, so the two edges that decide between a
//! rotation and a lockout — waiting for the backup acknowledgement, and the
//! fail-closed presence assertion immediately before the submit — are testable
//! without a sandbox, a network, or a relying party.

use std::sync::Mutex;

use async_trait::async_trait;
use opensesame_rotation_web::{
    run_change_password, ActionStep, BlockedReason, BrowserTransport, CandidateHandle,
    CandidateVault, ChangePasswordRecipe, CredentialRef, Filled, Presence, RunOutcome, StepError,
    Verified,
};
use opensesame_session_observe::{ControlLease, ControlState, Quiescence};

#[derive(Default)]
struct FakeBrowser {
    calls: Mutex<Vec<String>>,
    presence: Option<Presence>,
    verify: Option<Verified>,
    fill_result: Option<Filled>,
    navigate_error: bool,
    submit_error: bool,
    wait_error: Option<StepError>,
}

impl FakeBrowser {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, what: &str) {
        self.calls.lock().unwrap().push(what.to_string());
    }
}

#[async_trait]
impl BrowserTransport for FakeBrowser {
    async fn navigate(&self, _url: &str) -> Result<(), StepError> {
        self.record("navigate");
        if self.navigate_error {
            return Err(StepError::Navigation);
        }
        Ok(())
    }

    async fn wait_for(&self, _selector: &str) -> Result<(), StepError> {
        self.record("wait_for");
        self.wait_error.map_or(Ok(()), Err)
    }

    async fn fill_credential(
        &self,
        _reference: &CredentialRef,
        _selector: &str,
    ) -> Result<Filled, StepError> {
        self.record("fill");
        Ok(self.fill_result.unwrap_or(Filled::Ok))
    }

    async fn assert_present(
        &self,
        _reference: &CredentialRef,
        _selector: &str,
    ) -> Result<Presence, StepError> {
        self.record("assert");
        Ok(self.presence.unwrap_or(Presence::Present))
    }

    async fn submit(&self, _selector: &str) -> Result<(), StepError> {
        self.record("submit");
        if self.submit_error {
            return Err(StepError::Transport);
        }
        Ok(())
    }

    async fn read_dom_redacted(&self) -> Result<opensesame_rotation_web::RedactedDom, StepError> {
        Err(StepError::Transport)
    }

    async fn screenshot_redacted(
        &self,
        _mask: opensesame_session_observe::MaskManifest,
    ) -> Result<Option<opensesame_rotation_web::AdmittedFrame>, StepError> {
        Ok(None)
    }

    async fn verify_login(&self, _reference: &CredentialRef) -> Result<Verified, StepError> {
        self.record("verify");
        Ok(self.verify.unwrap_or(Verified::Works))
    }
}

struct FakeVault {
    backup_acknowledged: bool,
    calls: Mutex<Vec<String>>,
}

impl FakeVault {
    fn new(backup_acknowledged: bool) -> Self {
        Self {
            backup_acknowledged,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl CandidateVault for FakeVault {
    async fn generate_candidate(&self) -> Result<CandidateHandle, BlockedReason> {
        self.calls.lock().unwrap().push("generate".into());
        Ok(CandidateHandle::new("cand:1"))
    }

    async fn seal_and_await_backup(&self, _candidate: &CandidateHandle) -> bool {
        self.calls.lock().unwrap().push("seal_and_await".into());
        self.backup_acknowledged
    }

    async fn promote(&self, _candidate: &CandidateHandle) {
        self.calls.lock().unwrap().push("promote".into());
    }
}

fn recipe() -> ChangePasswordRecipe {
    ChangePasswordRecipe {
        change_url: "https://example.com/.well-known/change-password".into(),
        current_password_selector: Some("#current".into()),
        new_password_selector: "#new".into(),
        confirm_password_selector: Some("#confirm".into()),
        submit_selector: "#save".into(),
    }
}

fn current() -> CredentialRef {
    CredentialRef::new("conn:example")
}

#[tokio::test]
async fn the_happy_path_runs_in_the_one_order_that_is_safe() {
    let browser = FakeBrowser::default();
    let vault = FakeVault::new(true);
    let report = run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
        .await
        .unwrap();

    assert_eq!(report.outcome, RunOutcome::Completed);
    assert_eq!(
        report.steps,
        vec![
            ActionStep::Navigated,
            ActionStep::GeneratedCandidate,
            ActionStep::SealedAndBackedUp,
            ActionStep::FilledCurrent,
            ActionStep::FilledCandidate,
            ActionStep::FilledConfirmation,
            ActionStep::EnteredCriticalSection,
            ActionStep::AssertedCandidatePresent,
            ActionStep::Submitted,
            ActionStep::LeftCriticalSection,
            ActionStep::VerifiedByFreshLogin,
            ActionStep::Promoted,
        ]
    );
}

#[tokio::test]
async fn nothing_is_submitted_before_the_backup_is_acknowledged() {
    // The lockout this prevents: the site accepts a password nobody holds.
    let browser = FakeBrowser::default();
    let vault = FakeVault::new(false);
    let report = run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
        .await
        .unwrap();

    assert_eq!(
        report.outcome,
        RunOutcome::Blocked(BlockedReason::BackupNotAcknowledged)
    );
    assert!(!browser.calls().contains(&"submit".to_string()));
    assert!(!browser.calls().contains(&"fill".to_string()));
    assert_eq!(vault.calls(), vec!["generate", "seal_and_await"]);
}

#[tokio::test]
async fn the_assertion_immediately_precedes_the_submit() {
    let browser = FakeBrowser::default();
    let vault = FakeVault::new(true);
    run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
        .await
        .unwrap();

    let calls = browser.calls();
    let assert_at = calls.iter().position(|c| c == "assert").unwrap();
    let submit_at = calls.iter().position(|c| c == "submit").unwrap();
    // Not merely "before": adjacent. Anything between them is a window in
    // which the field could change and the assertion would be a claim about a
    // page that no longer exists.
    assert_eq!(
        submit_at,
        assert_at + 1,
        "nothing may run between the assertion and the submit: {calls:?}"
    );
}

#[tokio::test]
async fn a_field_that_did_not_take_the_candidate_aborts_before_submit() {
    // The forbidden implementation is fill-if-you-can-then-submit-anyway; that
    // is how a password silently becomes a placeholder.
    for presence in [Presence::Absent, Presence::Mismatch] {
        let browser = FakeBrowser {
            presence: Some(presence),
            ..FakeBrowser::default()
        };
        let vault = FakeVault::new(true);
        let report =
            run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
                .await
                .unwrap();

        assert_eq!(
            report.outcome,
            RunOutcome::Blocked(BlockedReason::CandidateAbsent),
            "{presence:?}"
        );
        assert!(!browser.calls().contains(&"submit".to_string()));
        assert!(!vault.calls().contains(&"promote".to_string()));
        // The run parked, and parking cleared the critical section.
        assert_eq!(report.lease.state(), ControlState::Suspended);
        assert_eq!(report.lease.quiescence(), Quiescence::Quiescent);
    }
}

#[tokio::test]
async fn a_rejected_or_ambiguous_verification_reconciles_rather_than_promoting() {
    // The site took the submit. We cannot say which credential is live, so the
    // previous value is retained and a person decides (ADR 0076 constraint 5).
    for verify in [Verified::Rejected, Verified::Indeterminate] {
        let browser = FakeBrowser {
            verify: Some(verify),
            ..FakeBrowser::default()
        };
        let vault = FakeVault::new(true);
        let report =
            run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
                .await
                .unwrap();

        assert!(
            matches!(report.outcome, RunOutcome::ReconciliationRequired(_)),
            "{verify:?} produced {:?}",
            report.outcome
        );
        assert!(!vault.calls().contains(&"promote".to_string()));
    }
}

#[tokio::test]
async fn a_challenge_parks_rather_than_being_worked_around() {
    // ADR 0076 constraint 4: a challenge is a stop signal, not an obstacle.
    let browser = FakeBrowser {
        wait_error: Some(StepError::Challenge),
        ..FakeBrowser::default()
    };
    let vault = FakeVault::new(true);
    let report = run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
        .await
        .unwrap();

    // The wait failing is drift from the recipe's point of view; either way
    // nothing was generated, sealed, filled or submitted.
    assert!(matches!(report.outcome, RunOutcome::Blocked(_)));
    assert_eq!(vault.calls(), Vec::<String>::new());
    assert!(!browser.calls().contains(&"submit".to_string()));
}

#[tokio::test]
async fn the_executor_stands_down_when_a_person_holds_the_page() {
    let browser = FakeBrowser::default();
    let vault = FakeVault::new(true);
    let mut lease = ControlLease::new();
    lease.park().unwrap();
    lease.grant_control().unwrap();

    let report = run_change_password(&browser, &vault, &recipe(), &current(), lease)
        .await
        .unwrap();

    assert_eq!(
        report.outcome,
        RunOutcome::Blocked(BlockedReason::HumanDriving)
    );
    // Not one call: the agent does not race a person for the DOM.
    assert_eq!(browser.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn a_failed_submit_reconciles_because_the_sites_state_is_unknown() {
    let browser = FakeBrowser {
        submit_error: true,
        ..FakeBrowser::default()
    };
    let vault = FakeVault::new(true);
    let report = run_change_password(&browser, &vault, &recipe(), &current(), ControlLease::new())
        .await
        .unwrap();

    assert!(matches!(
        report.outcome,
        RunOutcome::ReconciliationRequired(_)
    ));
    assert!(!vault.calls().contains(&"promote".to_string()));
    // The section closed even on the failure path: a run that parked inside it
    // would strand the lease.
    assert_eq!(report.lease.quiescence(), Quiescence::Quiescent);
}

#[tokio::test]
async fn a_handoff_asked_for_mid_submit_lands_after_it_not_during() {
    let browser = FakeBrowser::default();
    let vault = FakeVault::new(true);
    let mut lease = ControlLease::new();

    // A viewer presses "take the page" while the run is between its assertion
    // and its submit. The request is queued, not honoured.
    lease.enter_critical().unwrap();
    lease.request_handoff().unwrap();
    assert!(lease.handoff_queued());
    lease.leave_critical().unwrap();
    // Released only once the section closed.
    assert_eq!(lease.state(), ControlState::HandoffRequested);

    // And a run whose lease already left AgentDriving does not start.
    lease.park().unwrap();
    let report = run_change_password(&browser, &vault, &recipe(), &current(), lease)
        .await
        .unwrap();
    assert_eq!(
        report.outcome,
        RunOutcome::Blocked(BlockedReason::HumanDriving)
    );
}

#[tokio::test]
async fn every_blocked_reason_has_a_value_blind_hint() {
    for reason in [
        BlockedReason::Challenge,
        BlockedReason::RecipeDrift,
        BlockedReason::BackupNotAcknowledged,
        BlockedReason::CandidateAbsent,
        BlockedReason::HumanDriving,
        BlockedReason::Transport,
    ] {
        let hint = reason.detail();
        assert!(!hint.is_empty(), "{reason:?}");
        // The hint reaches a phone. It says what stopped, never what was seen.
        for forbidden in ["password=", "token", "secret", "cookie"] {
            assert!(!hint.contains(forbidden), "{reason:?}: {hint}");
        }
    }
}
