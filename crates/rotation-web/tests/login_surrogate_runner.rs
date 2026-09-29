//! The failure contract: a substituted login that fails falls back to CDP
//! fill once, never to substitution again; a tripwire parks the run instead
//! (ADR 0150 §6.3). The fake runner below drives a simulated page through the
//! real egress hook, so what the "server" received is what substitution
//! actually produced.
#![cfg(feature = "login-surrogate")]

mod login_support;

use std::sync::Mutex;

use async_trait::async_trait;
use login_support::{
    declared, form, plugin_on, post, secret, spec, ENTROPY, SECRET, SURROGATE, URL,
};
use opensesame_rotation_web::{
    run_login, run_surrogate_login, AdmittedFrame, ArmedSubstitution, BrowserTransport, CdpOnly,
    CredentialRef, Egress, EgressReport, FallbackReason, Filled, LoginOutcome, LoginRoad,
    LoginSubstitution, LoginVia, ParkReason, Presence, RedactedDom, RefusalCode, StepError,
    SurrogateLoginRecipe, SurrogateLoginTransport, Verified,
};
use opensesame_session_observe::MaskManifest;

/// What the page's script does with the field on submit.
#[derive(Clone, Copy)]
enum Page {
    /// Posts the field as typed.
    Honest,
    /// Posts it to its own collector instead.
    Exfiltrates,
    /// Hashes it client-side before posting.
    Hashes,
}

struct Runner {
    page: Page,
    /// What each login check answers, in order.
    settled: Mutex<Vec<Verified>>,
    field: Mutex<String>,
    calls: Mutex<Vec<&'static str>>,
    /// Bodies the site received.
    received: Mutex<Vec<String>>,
}

impl Runner {
    fn new(page: Page, settled: &[Verified]) -> Self {
        Self {
            page,
            settled: Mutex::new(settled.iter().rev().copied().collect()),
            field: Mutex::new(String::new()),
            calls: Mutex::new(Vec::new()),
            received: Mutex::new(Vec::new()),
        }
    }

    fn call(&self, name: &'static str) {
        self.calls.lock().unwrap().push(name);
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl BrowserTransport for Runner {
    async fn navigate(&self, _url: &str) -> Result<(), StepError> {
        self.call("navigate");
        Ok(())
    }

    async fn wait_for(&self, _selector: &str) -> Result<(), StepError> {
        Ok(())
    }

    async fn fill_credential(&self, _: &CredentialRef, _: &str) -> Result<Filled, StepError> {
        self.call("fill_credential");
        *self.field.lock().unwrap() = SECRET.to_string();
        Ok(Filled::Ok)
    }

    async fn assert_present(&self, _: &CredentialRef, _: &str) -> Result<Presence, StepError> {
        Ok(Presence::Present)
    }

    async fn submit(&self, _selector: &str) -> Result<(), StepError> {
        self.call("submit");
        let body = format!("password={}", self.field.lock().unwrap());
        self.received.lock().unwrap().push(body);
        Ok(())
    }

    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        Err(StepError::Transport)
    }

    async fn screenshot_redacted(
        &self,
        _: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        Ok(None)
    }

    async fn verify_login(&self, _: &CredentialRef) -> Result<Verified, StepError> {
        self.call("verify_login");
        Ok(Verified::Indeterminate)
    }
}

#[async_trait]
impl SurrogateLoginTransport for Runner {
    async fn fill_surrogate(
        &self,
        substitution: &ArmedSubstitution,
        _selector: &str,
    ) -> Result<Filled, StepError> {
        self.call("fill_surrogate");
        *self.field.lock().unwrap() = substitution.surrogate().as_str().to_string();
        Ok(Filled::Ok)
    }

    async fn submit_substituted(
        &self,
        substitution: &ArmedSubstitution,
        _reference: &CredentialRef,
        _selector: &str,
    ) -> Result<EgressReport, StepError> {
        self.call("submit_substituted");
        let typed = self.field.lock().unwrap().clone();
        let (url, value) = match self.page {
            Page::Honest => (URL, typed),
            Page::Exfiltrates => ("https://collector.example/c", typed),
            Page::Hashes => (URL, format!("{:x}", typed.len() * 7919)),
        };
        let headers = form();
        let body = format!("password={value}");
        match substitution.egress(&post(url, &headers, body.as_bytes()), &secret()) {
            Ok(Egress::Substituted(sent)) => {
                let sent = String::from_utf8(sent.body().to_vec()).unwrap();
                self.received.lock().unwrap().push(sent);
                Ok(EgressReport::Substituted)
            }
            Ok(Egress::Untouched) => {
                self.received.lock().unwrap().push(body);
                Ok(EgressReport::NotSeen)
            }
            Err(refusal) => Ok(EgressReport::Refused(refusal)),
        }
    }

    async fn login_settled(&self) -> Result<Verified, StepError> {
        self.call("login_settled");
        Ok(self
            .settled
            .lock()
            .unwrap()
            .pop()
            .unwrap_or(Verified::Indeterminate))
    }
}

fn recipe() -> SurrogateLoginRecipe {
    SurrogateLoginRecipe {
        login_url: "https://login.example/signin".into(),
        password_selector: "#password".into(),
        submit_selector: "button[type=submit]".into(),
    }
}

fn reference() -> CredentialRef {
    CredentialRef::new("vault://login.example/primary")
}

#[tokio::test]
async fn a_substituted_login_signs_in_with_the_credential_the_page_never_held() {
    let runner = Runner::new(Page::Honest, &[Verified::Works]);
    let report = run_surrogate_login(&runner, declared(), &recipe(), &reference()).await;
    assert_eq!(report.via, LoginVia::Substitution);
    assert_eq!(report.outcome, LoginOutcome::LoggedIn);
    assert_eq!(
        runner.calls(),
        [
            "navigate",
            "fill_surrogate",
            "submit_substituted",
            "login_settled"
        ]
    );
    // The page's field only ever held the surrogate; the site got the secret.
    assert_eq!(*runner.field.lock().unwrap(), SURROGATE);
    let received = runner.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
    assert!(!received[0].contains(SURROGATE));
}

#[tokio::test]
async fn a_rejected_substituted_login_falls_back_to_cdp_fill_and_never_retries_substitution() {
    let runner = Runner::new(Page::Honest, &[Verified::Rejected, Verified::Works]);
    let report = run_surrogate_login(&runner, declared(), &recipe(), &reference()).await;
    assert_eq!(report.via, LoginVia::CdpFill);
    assert_eq!(report.outcome, LoginOutcome::LoggedIn);
    assert_eq!(report.fell_back, Some(FallbackReason::Rejected));
    let calls = runner.calls();
    assert_eq!(calls.iter().filter(|c| **c == "fill_surrogate").count(), 1);
    assert_eq!(
        calls.iter().filter(|c| **c == "submit_substituted").count(),
        1
    );
    assert_eq!(
        &calls[4..],
        ["navigate", "fill_credential", "submit", "login_settled"]
    );
}

#[tokio::test]
async fn a_page_that_hashes_the_field_falls_back_to_cdp_fill() {
    let runner = Runner::new(Page::Hashes, &[Verified::Works]);
    let report = run_surrogate_login(&runner, declared(), &recipe(), &reference()).await;
    assert_eq!(report.fell_back, Some(FallbackReason::NotSubmitted));
    assert_eq!(report.via, LoginVia::CdpFill);
    assert_eq!(report.outcome, LoginOutcome::LoggedIn);
}

#[tokio::test]
async fn a_page_that_exfiltrates_the_surrogate_parks_the_run_and_sends_nothing() {
    let runner = Runner::new(Page::Exfiltrates, &[Verified::Works]);
    let report = run_surrogate_login(&runner, declared(), &recipe(), &reference()).await;
    assert_eq!(
        report.outcome,
        LoginOutcome::Parked(ParkReason::Tripwire(RefusalCode::Misdirected))
    );
    assert_eq!(report.via, LoginVia::Substitution);
    assert!(!runner.calls().contains(&"fill_credential"));
    assert!(runner.received.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_indeterminate_substituted_login_parks_rather_than_guessing() {
    let runner = Runner::new(Page::Honest, &[Verified::Indeterminate]);
    let report = run_surrogate_login(&runner, declared(), &recipe(), &reference()).await;
    assert_eq!(
        report.outcome,
        LoginOutcome::Parked(ParkReason::Indeterminate)
    );
    assert!(!runner.calls().contains(&"fill_credential"));
}

#[tokio::test]
async fn a_fallback_the_site_also_rejects_is_rejected() {
    let runner = Runner::new(Page::Honest, &[Verified::Rejected, Verified::Rejected]);
    let report = run_surrogate_login(&runner, declared(), &recipe(), &reference()).await;
    assert_eq!(report.via, LoginVia::CdpFill);
    assert_eq!(report.outcome, LoginOutcome::Rejected);
}

/// A declared login with the plugin's switch recorded `enabled`.
fn road(enabled: bool) -> LoginRoad {
    let declared = LoginSubstitution::declare(spec("password"), ENTROPY).unwrap();
    let mut plugin = plugin_on();
    plugin.enabled = enabled;
    plugin.active = enabled;
    LoginRoad::choose(Some(declared), &plugin)
}

#[tokio::test]
async fn a_switched_off_plugin_logs_in_by_cdp_fill_and_never_types_a_surrogate() {
    let runner = Runner::new(Page::Honest, &[Verified::Works]);
    let road = road(false);
    assert!(matches!(road, LoginRoad::CdpFill(CdpOnly::SwitchedOff)));
    let report = run_login(&runner, road, &recipe(), &reference()).await;
    assert_eq!(report.via, LoginVia::CdpFill);
    assert_eq!(report.outcome, LoginOutcome::LoggedIn);
    assert_eq!(report.fell_back, None);
    assert_eq!(
        runner.calls(),
        ["navigate", "fill_credential", "submit", "login_settled"]
    );
    assert_eq!(*runner.field.lock().unwrap(), SECRET);
}

#[tokio::test]
async fn a_switched_on_plugin_runs_the_declared_substitution() {
    let runner = Runner::new(Page::Honest, &[Verified::Works]);
    let report = run_login(&runner, road(true), &recipe(), &reference()).await;
    assert_eq!(report.via, LoginVia::Substitution);
    assert_eq!(report.outcome, LoginOutcome::LoggedIn);
    assert!(!runner.calls().contains(&"fill_credential"));
}
