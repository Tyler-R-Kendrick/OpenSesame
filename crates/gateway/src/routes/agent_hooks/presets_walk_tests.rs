//! The rotation preset proven by walking real hooked runs under it: a full
//! change-password walk, a capture ceremony, and each of the eleven verbs of
//! the tool boundary decided by the real `OpenSesame` interceptor.

use std::sync::Mutex;

use async_trait::async_trait;
use opensesame_agent_hooks::sdk::Verdict;
use opensesame_agent_hooks::{HookPolicy, OpenSesameInterceptor};
use opensesame_ceremony::{CaptureDigest, Slot};
use opensesame_rotation_web::hooks::{
    HookSession, HookedTransport, HostInput, InputRole, RunKind, RunRequest, SessionConfig,
    BROWSER_VERBS, CEREMONY_VERBS,
};
use opensesame_rotation_web::{
    run_capture_steps_hooked, run_change_password_hooked, AdmittedFrame, BlockedReason,
    BrowserTransport, CandidateHandle, CandidateVault, CaptureError, CaptureStep,
    CeremonyTransport, ChangePasswordRecipe, CredentialRef, Filled, Presence, RedactedDom,
    RunOutcome, StepError, Verified,
};
use opensesame_session_observe::{ControlLease, LayoutEpoch, MaskManifest};
use serde_json::json;

use super::tests::policy_of;

/// A browser that answers the happy path and records its verbs.
#[derive(Default)]
struct Browser {
    verbs: Mutex<Vec<&'static str>>,
}

impl Browser {
    fn log(&self, verb: &'static str) {
        self.verbs.lock().unwrap().push(verb);
    }
    fn verbs(&self) -> Vec<&'static str> {
        self.verbs.lock().unwrap().clone()
    }
}

#[async_trait]
impl BrowserTransport for Browser {
    async fn navigate(&self, _url: &str) -> Result<(), StepError> {
        self.log("navigate");
        Ok(())
    }
    async fn wait_for(&self, _selector: &str) -> Result<(), StepError> {
        self.log("wait_for");
        Ok(())
    }
    async fn fill_credential(&self, _: &CredentialRef, _: &str) -> Result<Filled, StepError> {
        self.log("fill_credential");
        Ok(Filled::Ok)
    }
    async fn assert_present(&self, _: &CredentialRef, _: &str) -> Result<Presence, StepError> {
        self.log("assert_present");
        Ok(Presence::Present)
    }
    async fn submit(&self, _selector: &str) -> Result<(), StepError> {
        self.log("submit");
        Ok(())
    }
    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        self.log("read_dom_redacted");
        Ok(RedactedDom::from_stripped("a form".into(), LayoutEpoch(1)))
    }
    async fn screenshot_redacted(
        &self,
        mask: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        self.log("screenshot_redacted");
        Ok(Some(AdmittedFrame::new(vec![1, 2, 3], mask.epoch())))
    }
    async fn verify_login(&self, _: &CredentialRef) -> Result<Verified, StepError> {
        self.log("verify_login");
        Ok(Verified::Works)
    }
}

#[async_trait]
impl CeremonyTransport for Browser {
    async fn outstanding(&self) -> Vec<Slot> {
        self.log("outstanding");
        Vec::new()
    }
    async fn capture_credential(
        &self,
        slot: Slot,
        _selector: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        self.log("capture_credential");
        Ok(CaptureDigest::of_sealed(
            slot,
            format!("blob:{}", slot.as_str()),
        ))
    }
    async fn capture_download(
        &self,
        slot: Slot,
        _content_type: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        self.log("capture_download");
        Ok(CaptureDigest::of_sealed(
            slot,
            format!("blob:{}", slot.as_str()),
        ))
    }
}

struct Vault;

#[async_trait]
impl CandidateVault for Vault {
    async fn generate_candidate(&self) -> Result<CandidateHandle, BlockedReason> {
        Ok(CandidateHandle::new("cand:1"))
    }
    async fn seal_and_await_backup(&self, _: &CandidateHandle) -> bool {
        true
    }
    async fn promote(&self, _: &CandidateHandle) {}
}

fn recipe() -> ChangePasswordRecipe {
    ChangePasswordRecipe {
        change_url: "https://example.com/.well-known/change-password".into(),
        current_password_selector: Some("#current".into()),
        new_password_selector: "#new".into(),
        confirm_password_selector: None,
        submit_selector: "#save".into(),
    }
}

fn request(run: RunKind) -> RunRequest {
    RunRequest {
        run,
        recipe: "example".into(),
        origin: "https://example.com".into(),
    }
}

/// A hooked transport whose interceptor is the `OpenSesame` interceptor under
/// `policy` — the real judge, not a script.
fn hooked_under(policy: HookPolicy) -> HookedTransport<Browser> {
    let session = HookSession::new(
        SessionConfig::new("run:preset"),
        vec![Box::new(OpenSesameInterceptor::new(policy))],
        None,
    )
    .unwrap();
    HookedTransport::new(Browser::default(), session)
}

#[tokio::test]
async fn the_rotation_preset_allows_a_full_hooked_change_password_walk() {
    let hooked = hooked_under(policy_of("rotation-web-login"));
    let report = run_change_password_hooked(
        &hooked,
        &Vault,
        &recipe(),
        &CredentialRef::new("conn:example"),
        ControlLease::new(),
        &request(RunKind::ChangePassword),
    )
    .await
    .expect("no point of the run is refused");
    assert_eq!(report.outcome, RunOutcome::Completed, "{:?}", report.steps);
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
    // Every emission was decided, none refused: startup, input, 7 verbs
    // before and after, output, shutdown.
    let records = hooked.session().records().await;
    assert_eq!(records.len(), 2 + 7 * 2 + 2);
    assert!(records
        .iter()
        .all(|record| !serde_json::to_string(record).unwrap().contains("\"deny\"")));
}

#[tokio::test]
async fn the_rotation_preset_allows_a_capture_ceremony_and_the_page_reads() {
    let hooked = hooked_under(policy_of("rotation-web-login"));
    let steps = [
        CaptureStep::Field {
            slot: Slot::ClientId,
            selector: "#id".into(),
        },
        CaptureStep::Download {
            slot: Slot::ClientSecret,
            content_type: "application/json".into(),
        },
    ];
    let report = run_capture_steps_hooked(&hooked, &steps, &request(RunKind::Capture))
        .await
        .expect("a capture under the preset is not refused");
    assert_eq!(report.sealed.len(), 2);
    assert!(report.is_complete());
    let verbs = hooked.inner().verbs();
    for verb in ["capture_credential", "capture_download", "outstanding"] {
        assert!(verbs.contains(&verb), "{verb}: {verbs:?}");
    }
}

#[tokio::test]
async fn every_one_of_the_eleven_verbs_is_allowed_in_an_open_turn() {
    let hooked = hooked_under(policy_of("rotation-web-login"));
    let tools: Vec<&str> = BROWSER_VERBS
        .iter()
        .chain(&CEREMONY_VERBS)
        .copied()
        .collect();
    hooked.session().startup(&tools).await.unwrap();
    let input = HostInput {
        content: json!({"run": "capture", "recipe": "example", "origin": "https://example.com"}),
        role: InputRole::System,
    };
    hooked.session().input(&input).await.unwrap();

    let reference = CredentialRef::new("conn:example");
    assert!(hooked.navigate("https://example.com").await.is_ok());
    assert!(hooked.wait_for("#new").await.is_ok());
    assert!(hooked.fill_credential(&reference, "#new").await.is_ok());
    assert!(hooked.assert_present(&reference, "#new").await.is_ok());
    assert!(hooked.submit("#save").await.is_ok());
    assert!(hooked.read_dom_redacted().await.is_ok());
    let mask = MaskManifest::solved(LayoutEpoch(1), 0, 0);
    assert!(hooked.screenshot_redacted(mask).await.is_ok());
    assert!(hooked.verify_login(&reference).await.is_ok());
    assert!(hooked.outstanding().await.is_empty());
    assert!(!hooked.ledger_refused());
    assert!(hooked
        .capture_credential(Slot::ClientId, "#id")
        .await
        .is_ok());
    assert!(hooked
        .capture_download(Slot::ClientSecret, "application/json")
        .await
        .is_ok());
    assert_eq!(hooked.inner().verbs().len(), 11, "none was refused");
    // The page reads are labelled, so a later emission carries where the
    // content came from.
    let records = serde_json::to_string(&hooked.session().records().await).unwrap();
    assert!(records.contains("opensesame:untrusted_page"), "{records}");
}

#[test]
fn the_preset_refuses_what_it_does_not_name_through_the_real_interceptor() {
    let interceptor = OpenSesameInterceptor::new(policy_of("rotation-web-login"));
    let context = |name: &str| {
        json!({
            "spec": "agent-hooks/0.1",
            "interception_point": "pre_tool_call",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "sequence": 1,
            "agent": {"id": "a", "framework": "reference"},
            "session": {"id": "s"},
            "tool_call": {"id": "t", "name": name, "args": {}},
            "target": {},
        })
        .to_string()
    };
    let verdict: Verdict = interceptor.decide_json(&context("shell"));
    assert_eq!(verdict.decision.as_str(), "deny");
    assert_eq!(verdict.reason.as_deref(), Some("opensesame:tool_denied"));
    assert!(verdict.approval.is_none(), "a plain deny, nothing lifts it");
    assert_eq!(
        interceptor
            .decide_json(&context("navigate"))
            .decision
            .as_str(),
        "allow"
    );
}
