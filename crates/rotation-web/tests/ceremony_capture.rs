//! The capture boundary (ADR 0082 §3), proved against a fake browser holding
//! real plaintext.
//!
//! The fake is the point. It stands where a real controller stands — it is the
//! only thing here that ever sees a value — so the tests can ask the question
//! that matters: after a refused capture, is the value anywhere? A double that
//! returned canned digests would pass every one of these and prove nothing.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use opensesame_ceremony::{CaptureDigest, CaptureRefusal, DeclaredSlots, Slot};
use opensesame_rotation_web::{
    run_capture_steps, AdmittedFrame, BrowserTransport, CaptureError, CaptureStep,
    CeremonyTransport, CredentialRef, Filled, Presence, RedactedDom, StepError, Verified,
};

const PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
const HTML: &str = "<!doctype html><html><body>Sign in to continue";

/// A page, a vault, and the ledger — all the things a real controller holds.
struct FakeCeremony {
    /// What the page would yield for a selector.
    page: BTreeMap<String, String>,
    /// What a download would deliver: (content type, body).
    download: Mutex<Option<(String, String)>>,
    /// The ledger, where the plaintext holder keeps it.
    slots: Mutex<DeclaredSlots>,
    /// Stand-in for the vault. Nothing outside this struct can read it.
    sealed: Mutex<Vec<(Slot, String)>>,
    /// Every capture attempt, so a test can prove a step never ran.
    attempts: Mutex<Vec<String>>,
}

impl FakeCeremony {
    fn declaring(slots: &[Slot]) -> Self {
        Self {
            page: BTreeMap::new(),
            download: Mutex::new(None),
            slots: Mutex::new(DeclaredSlots::declare(slots)),
            sealed: Mutex::new(Vec::new()),
            attempts: Mutex::new(Vec::new()),
        }
    }

    fn showing(mut self, selector: &str, value: &str) -> Self {
        self.page.insert(selector.to_string(), value.to_string());
        self
    }

    fn delivering(self, content_type: &str, body: &str) -> Self {
        *self.download.lock().unwrap() = Some((content_type.to_string(), body.to_string()));
        self
    }

    fn attempts(&self) -> Vec<String> {
        self.attempts.lock().unwrap().clone()
    }

    /// What actually reached the vault.
    fn sealed_slots(&self) -> Vec<Slot> {
        self.sealed
            .lock()
            .unwrap()
            .iter()
            .map(|(slot, _)| *slot)
            .collect()
    }

    fn vault_holds(&self, value: &str) -> bool {
        self.sealed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, held)| held == value)
    }

    /// Admit and seal, in the order a real controller must: the ledger decides,
    /// and only then does anything reach the vault.
    fn admit_and_seal(&self, slot: Slot, value: &str) -> Result<CaptureDigest, CaptureError> {
        self.slots.lock().unwrap().admit(slot, value)?;
        self.sealed.lock().unwrap().push((slot, value.to_string()));
        // The marker comes off the sealed blob's position, never off the
        // plaintext: a digest of a secret is a crackable artifact.
        let marker = format!("sealed:{}", self.sealed.lock().unwrap().len());
        Ok(CaptureDigest::of_sealed(slot, marker))
    }
}

#[async_trait]
impl BrowserTransport for FakeCeremony {
    async fn navigate(&self, _url: &str) -> Result<(), StepError> {
        Ok(())
    }
    async fn wait_for(&self, _selector: &str) -> Result<(), StepError> {
        Ok(())
    }
    async fn fill_credential(
        &self,
        _reference: &CredentialRef,
        _selector: &str,
    ) -> Result<Filled, StepError> {
        Ok(Filled::Ok)
    }
    async fn assert_present(
        &self,
        _reference: &CredentialRef,
        _selector: &str,
    ) -> Result<Presence, StepError> {
        Ok(Presence::Present)
    }
    async fn submit(&self, _selector: &str) -> Result<(), StepError> {
        Ok(())
    }
    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        Err(StepError::Transport)
    }
    async fn screenshot_redacted(
        &self,
        _mask: opensesame_session_observe::MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        Ok(None)
    }
    async fn verify_login(&self, _reference: &CredentialRef) -> Result<Verified, StepError> {
        Ok(Verified::Works)
    }
}

#[async_trait]
impl CeremonyTransport for FakeCeremony {
    async fn outstanding(&self) -> Vec<Slot> {
        self.slots.lock().unwrap().outstanding()
    }

    async fn capture_credential(
        &self,
        slot: Slot,
        selector: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        self.attempts
            .lock()
            .unwrap()
            .push(format!("field:{}", slot.as_str()));
        let value = self
            .page
            .get(selector)
            .ok_or(CaptureError::Step(StepError::NoSuchElement))?;
        self.admit_and_seal(slot, value)
    }

    async fn capture_download(
        &self,
        slot: Slot,
        content_type: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        self.attempts
            .lock()
            .unwrap()
            .push(format!("download:{}", slot.as_str()));
        let delivered = self.download.lock().unwrap().clone();
        let (kind, body) = delivered.ok_or(CaptureError::Step(StepError::Timeout))?;
        if kind != content_type {
            return Err(CaptureError::Refused(CaptureRefusal::WrongContentType));
        }
        self.admit_and_seal(slot, &body)
    }
}

fn field(slot: Slot, selector: &str) -> CaptureStep {
    CaptureStep::Field {
        slot,
        selector: selector.to_string(),
    }
}

#[tokio::test]
async fn a_complete_ceremony_seals_every_declared_slot_and_says_so() {
    let browser = FakeCeremony::declaring(&[Slot::AppId, Slot::ClientId])
        .showing("#app-id", "48271")
        .showing("#client-id", "Iv1.a1b2c3d4e5f6");

    let report = run_capture_steps(
        &browser,
        &[
            field(Slot::AppId, "#app-id"),
            field(Slot::ClientId, "#client-id"),
        ],
    )
    .await
    .expect("both slots are declared and both values fit");

    assert!(report.is_complete());
    assert!(report.outstanding.is_empty());
    assert_eq!(
        report
            .sealed
            .iter()
            .map(CaptureDigest::slot)
            .collect::<Vec<_>>(),
        vec![Slot::AppId, Slot::ClientId],
    );
}

#[tokio::test]
async fn a_slot_the_recipe_did_not_declare_seals_nothing() {
    // ADR 0082 §3, the load-bearing one: a model free to choose what to capture
    // could seal the page's session cookie as a client secret. The recipe
    // declares `app_id` only, so a step naming `client_secret` must not put
    // anything in the vault — even though the page is happily showing one.
    let browser = FakeCeremony::declaring(&[Slot::AppId])
        .showing("#app-id", "48271")
        .showing("#secret", "sess_cookie_value_here");

    let error = run_capture_steps(&browser, &[field(Slot::ClientSecret, "#secret")])
        .await
        .expect_err("an undeclared slot is refused");

    assert_eq!(
        error,
        CaptureError::Refused(CaptureRefusal::SlotNotDeclared)
    );
    assert!(browser.sealed_slots().is_empty(), "something was sealed");
    assert!(!browser.vault_holds("sess_cookie_value_here"));
}

#[tokio::test]
async fn an_error_page_where_a_key_was_expected_is_refused_rather_than_sealed() {
    // The failure this whole check exists to prevent: seal the HTML and the
    // signing key fails months later, during a backup.
    let browser = FakeCeremony::declaring(&[Slot::PrivateKey]).showing("#key", HTML);

    let error = run_capture_steps(&browser, &[field(Slot::PrivateKey, "#key")])
        .await
        .expect_err("HTML is not a PEM");

    assert_eq!(error, CaptureError::Refused(CaptureRefusal::WrongShape));
    assert!(!browser.vault_holds(HTML));
}

#[tokio::test]
async fn a_refusal_stops_the_run_before_the_next_step_is_attempted() {
    // Carrying on would reach the end with a slot empty and the failure buried
    // mid-receipt, which is the "looks configured, does nothing" outcome.
    let browser = FakeCeremony::declaring(&[Slot::AppId, Slot::ClientId])
        .showing("#app-id", "not-a-number")
        .showing("#client-id", "Iv1.a1b2c3d4e5f6");

    let error = run_capture_steps(
        &browser,
        &[
            field(Slot::AppId, "#app-id"),
            field(Slot::ClientId, "#client-id"),
        ],
    )
    .await
    .expect_err("an app id must be digits");

    assert_eq!(error, CaptureError::Refused(CaptureRefusal::WrongShape));
    assert_eq!(
        browser.attempts(),
        vec!["field:app_id"],
        "the run continued past a refusal",
    );
    assert!(browser.sealed_slots().is_empty());
}

#[tokio::test]
async fn a_download_that_arrives_as_the_wrong_type_is_refused() {
    // GitHub delivers the App key as a file. A download that comes back as
    // text/html is the sign-in page, not a key.
    let browser = FakeCeremony::declaring(&[Slot::PrivateKey]).delivering("text/html", HTML);

    let error = run_capture_steps(
        &browser,
        &[CaptureStep::Download {
            slot: Slot::PrivateKey,
            content_type: "application/x-pem-file".to_string(),
        }],
    )
    .await
    .expect_err("the declared content type did not arrive");

    assert_eq!(
        error,
        CaptureError::Refused(CaptureRefusal::WrongContentType)
    );
    assert!(browser.sealed_slots().is_empty());
}

#[tokio::test]
async fn a_key_that_does_arrive_as_a_download_is_sealed() {
    let browser =
        FakeCeremony::declaring(&[Slot::PrivateKey]).delivering("application/x-pem-file", PEM);

    let report = run_capture_steps(
        &browser,
        &[CaptureStep::Download {
            slot: Slot::PrivateKey,
            content_type: "application/x-pem-file".to_string(),
        }],
    )
    .await
    .expect("a PEM delivered as a PEM");

    assert!(report.is_complete());
    assert_eq!(report.sealed[0].slot(), Slot::PrivateKey);
    assert!(browser.vault_holds(PEM), "the key never reached the vault");
}

#[tokio::test]
async fn what_comes_back_to_the_caller_redeems_nothing() {
    // The ConnectionRef property (ADR 0005), asserted on the wire form: a
    // caller holding the whole report holds no material.
    let browser =
        FakeCeremony::declaring(&[Slot::PrivateKey]).delivering("application/x-pem-file", PEM);

    let report = run_capture_steps(
        &browser,
        &[CaptureStep::Download {
            slot: Slot::PrivateKey,
            content_type: "application/x-pem-file".to_string(),
        }],
    )
    .await
    .expect("a PEM delivered as a PEM");

    let wire = serde_json::to_string(&report).expect("the report serializes");
    assert!(
        !wire.contains("BEGIN"),
        "the report carried PEM armor: {wire}"
    );
    assert!(
        !wire.contains("MIIBOgIBAAJBAK"),
        "the report carried key bytes"
    );
    assert!(
        wire.contains("private_key"),
        "it should still name the slot"
    );
}

#[tokio::test]
async fn an_incomplete_run_names_what_is_still_owed() {
    // ADR 0082 §6: a partial capture is not a success, and the report has to
    // say which slot is missing rather than leave it to be counted.
    let browser = FakeCeremony::declaring(&[Slot::AppId, Slot::PrivateKey, Slot::InstallationId])
        .showing("#app-id", "48271");

    let report = run_capture_steps(&browser, &[field(Slot::AppId, "#app-id")])
        .await
        .expect("the one step it was given succeeds");

    assert!(!report.is_complete());
    assert_eq!(
        report.outstanding,
        vec![Slot::PrivateKey, Slot::InstallationId],
    );
}

#[tokio::test]
async fn a_page_problem_is_retryable_and_a_refusal_is_not() {
    // Retrying a verdict re-reads the same wrong thing forever.
    let browser = FakeCeremony::declaring(&[Slot::AppId]);
    let missing = run_capture_steps(&browser, &[field(Slot::AppId, "#nowhere")])
        .await
        .expect_err("the selector matched nothing");
    assert_eq!(missing, CaptureError::Step(StepError::NoSuchElement));
    assert!(missing.is_retryable());

    let browser = FakeCeremony::declaring(&[Slot::AppId]).showing("#app-id", HTML);
    let refused = run_capture_steps(&browser, &[field(Slot::AppId, "#app-id")])
        .await
        .expect_err("HTML is not digits");
    assert!(!refused.is_retryable());
}

#[tokio::test]
async fn one_slot_cannot_be_captured_twice() {
    // Overwriting would make the sealed value and the receipt describe
    // different things.
    let browser = FakeCeremony::declaring(&[Slot::AppId]).showing("#app-id", "48271");

    let error = run_capture_steps(
        &browser,
        &[field(Slot::AppId, "#app-id"), field(Slot::AppId, "#app-id")],
    )
    .await
    .expect_err("the second capture into one slot is refused");

    assert_eq!(
        error,
        CaptureError::Refused(CaptureRefusal::SlotAlreadyFilled)
    );
    assert_eq!(browser.sealed_slots(), vec![Slot::AppId], "sealed twice");
}

#[tokio::test]
async fn a_challenge_and_a_refused_navigation_are_answers_rather_than_accidents() {
    // A runner honouring `is_retryable` would otherwise spin against a relying
    // party that asked for a human, and against an egress policy that will
    // refuse identically forever.
    for answered in [StepError::Navigation, StepError::Challenge] {
        assert!(
            !CaptureError::Step(answered).is_retryable(),
            "{answered:?} is an answer, not a timing problem",
        );
    }
    for timing in [
        StepError::Timeout,
        StepError::NoSuchElement,
        StepError::Transport,
    ] {
        assert!(
            CaptureError::Step(timing).is_retryable(),
            "{timing:?} is worth another attempt",
        );
    }
    assert!(!CaptureError::Refused(CaptureRefusal::WrongShape).is_retryable());
}
