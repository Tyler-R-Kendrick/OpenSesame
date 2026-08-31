//! A capture crossing the step channel sealed (ADR 0082 §3, ADR 0076 §8).
//!
//! `extension.rs` says the driver does not get to declare its own frame safe.
//! Capture is the same rule applied to material: the driver seals what it read
//! to the host's vault key and cannot open it again, and every judgement — is
//! this slot declared, is this the right shape, has it already been filled —
//! happens on the side that has something to lose.
//!
//! The fake vault below "encrypts" by reversing bytes into hex. Trivial, and
//! deliberately not the identity: it is what lets these tests assert that the
//! plaintext is genuinely absent from the wire rather than merely renamed.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use opensesame_ceremony::{CaptureRefusal, Slot};
use opensesame_rotation_web::{
    run_capture_steps, CaptureError, CaptureStep, CaptureVault, CeremonyTransport,
    ExtensionTransport, SealedCapture, StepChannel, StepError, StepOutcome, StepRequest,
};

const HOST_KEY: &str = "age1hostvaultkey";
const PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";

fn seal_to(recipient: &str, value: &str) -> SealedCapture {
    let envelope = value.bytes().rev().fold(String::new(), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    });
    SealedCapture {
        recipient: recipient.to_string(),
        envelope,
    }
}

/// The host side: holds the key, holds the store, and records what reached it.
#[derive(Default)]
struct FakeVault {
    stored: Mutex<Vec<(Slot, String)>>,
    opens: Mutex<u32>,
}

impl FakeVault {
    fn stored_slots(&self) -> Vec<Slot> {
        self.stored
            .lock()
            .unwrap()
            .iter()
            .map(|(s, _)| *s)
            .collect()
    }
    fn holds(&self, value: &str) -> bool {
        self.stored.lock().unwrap().iter().any(|(_, v)| v == value)
    }
    fn opens(&self) -> u32 {
        *self.opens.lock().unwrap()
    }
}

impl FakeVault {
    fn unseal(&self, sealed: &SealedCapture) -> Result<String, StepError> {
        *self.opens.lock().unwrap() += 1;
        let bytes: Result<Vec<u8>, _> = (0..sealed.envelope.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&sealed.envelope[i..i + 2], 16))
            .collect();
        let mut bytes = bytes.map_err(|_| StepError::Transport)?;
        bytes.reverse();
        String::from_utf8(bytes).map_err(|_| StepError::Transport)
    }

    fn put(&self, slot: Slot, value: &str) -> String {
        let mut stored = self.stored.lock().unwrap();
        stored.push((slot, value.to_string()));
        format!("sealed:{}", stored.len())
    }
}

/// A handle onto the vault, so a test keeps a view of the store after the
/// transport has taken ownership. Asserting on what reached the vault is the
/// whole point of these tests.
struct VaultHandle(Arc<FakeVault>);

#[async_trait]
impl CaptureVault for VaultHandle {
    fn recipient(&self) -> &str {
        HOST_KEY
    }

    async fn open(&self, sealed: &SealedCapture) -> Result<String, StepError> {
        self.0.unseal(sealed)
    }

    async fn store(&self, slot: Slot, value: &str) -> Result<String, StepError> {
        Ok(self.0.put(slot, value))
    }
}

/// A driver that seals whatever it was told to produce.
struct FakeDriver {
    /// What the page yields, per slot name.
    yields: Vec<(String, String)>,
    /// Seal to this instead of the requested recipient, when set.
    misaddress: Option<String>,
    seen: Mutex<Vec<StepRequest>>,
}

impl FakeDriver {
    fn yielding(pairs: &[(Slot, &str)]) -> Self {
        Self {
            yields: pairs
                .iter()
                .map(|(slot, value)| (slot.as_str().to_string(), (*value).to_string()))
                .collect(),
            misaddress: None,
            seen: Mutex::new(Vec::new()),
        }
    }
    fn sealing_to(mut self, recipient: &str) -> Self {
        self.misaddress = Some(recipient.to_string());
        self
    }
    fn seen(&self) -> Vec<StepRequest> {
        self.seen.lock().unwrap().clone()
    }
    fn answer(&self, slot: &str, recipient: &str) -> StepOutcome {
        let Some((_, value)) = self.yields.iter().find(|(name, _)| name == slot) else {
            return StepOutcome::Failed {
                error: StepError::NoSuchElement,
            };
        };
        let to = self.misaddress.as_deref().unwrap_or(recipient);
        StepOutcome::Captured {
            sealed: seal_to(to, value),
        }
    }
}

#[async_trait]
impl StepChannel for FakeDriver {
    async fn dispatch(&self, request: StepRequest) -> Result<StepOutcome, StepError> {
        self.seen.lock().unwrap().push(request.clone());
        match &request {
            StepRequest::CaptureCredential {
                slot, recipient, ..
            }
            | StepRequest::CaptureDownload {
                slot, recipient, ..
            } => Ok(self.answer(slot, recipient)),
            _ => Ok(StepOutcome::Done),
        }
    }
}

fn field(slot: Slot, selector: &str) -> CaptureStep {
    CaptureStep::Field {
        slot,
        selector: selector.to_string(),
    }
}

#[tokio::test]
async fn a_capture_round_trips_through_the_envelope() {
    let driver = FakeDriver::yielding(&[(Slot::AppId, "48271")]);
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new())
        .capturing(Box::new(VaultHandle(Arc::clone(&vault))), &[Slot::AppId]);

    let report = run_capture_steps(&transport, &[field(Slot::AppId, "#app-id")])
        .await
        .expect("a declared slot with a well-shaped value");

    assert!(report.is_complete());
    assert_eq!(report.sealed[0].slot(), Slot::AppId);
    assert_eq!(report.sealed[0].marker(), "sealed:1");
    assert_eq!(vault.stored_slots(), vec![Slot::AppId]);
    assert!(vault.holds("48271"), "the value never reached the vault");
}

#[tokio::test]
async fn nothing_the_driver_sends_back_carries_the_value() {
    // The wire property, asserted on the serialized outcome rather than on the
    // type: a channel is exactly where a convenient extra field gets added.
    let secret = "Iv1.a1b2c3d4e5f6";
    let outcome = StepOutcome::Captured {
        sealed: seal_to(HOST_KEY, secret),
    };
    let wire = serde_json::to_string(&outcome).expect("the outcome serializes");
    assert!(
        !wire.contains(secret),
        "the value crossed in the clear: {wire}"
    );
    assert!(
        wire.contains(HOST_KEY),
        "it should name who it was sealed to"
    );
}

#[tokio::test]
async fn a_refused_value_never_reaches_the_vault() {
    // The whole reason the order is open, admit, store. A vault that briefly
    // held a session cookie labelled `client_secret` is the ADR 0082 §3
    // outcome, and deleting it afterwards is not the same as never writing it.
    let driver = FakeDriver::yielding(&[(Slot::AppId, "not-a-number")]);
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new())
        .capturing(Box::new(VaultHandle(Arc::clone(&vault))), &[Slot::AppId]);

    let error = transport
        .capture_credential(Slot::AppId, "#app-id")
        .await
        .expect_err("an app id must be digits");

    assert_eq!(error, CaptureError::Refused(CaptureRefusal::WrongShape));
    assert!(
        vault.stored_slots().is_empty(),
        "a refused value reached the store",
    );
    assert!(!vault.holds("not-a-number"));
    assert!(transport.outstanding().await.contains(&Slot::AppId));
}

#[tokio::test]
async fn an_undeclared_slot_is_refused_after_opening_and_before_storing() {
    // The envelope has to be opened to be judged — that is what the host key is
    // for — but opening is not accepting. Nothing reaches the store.
    let driver = FakeDriver::yielding(&[(Slot::ClientSecret, "sess_cookie_value")]);
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new())
        .capturing(Box::new(VaultHandle(Arc::clone(&vault))), &[Slot::AppId]);

    let error = transport
        .capture_credential(Slot::ClientSecret, "#secret")
        .await
        .expect_err("the recipe declares app_id only");

    assert_eq!(
        error,
        CaptureError::Refused(CaptureRefusal::SlotNotDeclared)
    );
    assert_eq!(
        vault.opens(),
        1,
        "the envelope has to be opened to be judged"
    );
    assert!(
        vault.stored_slots().is_empty(),
        "opening is not accepting: nothing may reach the store",
    );
    assert!(!vault.holds("sess_cookie_value"));
}

#[tokio::test]
async fn an_envelope_sealed_to_another_key_is_refused_without_being_opened() {
    // An envelope from somewhere else is not a capture from our run, and the
    // honest response is to refuse rather than to try the key and see.
    let driver = FakeDriver::yielding(&[(Slot::AppId, "48271")]).sealing_to("age1someoneelseskey");
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new())
        .capturing(Box::new(VaultHandle(Arc::clone(&vault))), &[Slot::AppId]);

    let error = transport
        .capture_credential(Slot::AppId, "#app-id")
        .await
        .expect_err("addressed to a key we did not offer");

    assert_eq!(error, CaptureError::Step(StepError::Transport));
    assert_eq!(
        vault.opens(),
        0,
        "a misaddressed envelope was opened anyway"
    );
    assert!(vault.stored_slots().is_empty());
    assert!(transport.outstanding().await.contains(&Slot::AppId));
}

#[tokio::test]
async fn a_transport_built_without_a_vault_cannot_capture() {
    // Capture is opt-in at construction, so a rotation runner cannot acquire
    // the ability part-way through a run.
    let driver = FakeDriver::yielding(&[(Slot::AppId, "48271")]);
    let transport = ExtensionTransport::new(driver, Vec::new());

    let error = transport
        .capture_credential(Slot::AppId, "#app-id")
        .await
        .expect_err("there is nowhere for this to go");

    assert_eq!(error, CaptureError::Step(StepError::Transport));
    assert!(transport.outstanding().await.is_empty());
}

#[tokio::test]
async fn the_request_tells_the_driver_which_key_to_seal_to() {
    // The driver needs the recipient before it has anything to send, so it
    // travels with the request rather than being negotiated.
    let driver = FakeDriver::yielding(&[(Slot::AppId, "48271")]);
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new())
        .capturing(Box::new(VaultHandle(Arc::clone(&vault))), &[Slot::AppId]);

    transport
        .capture_credential(Slot::AppId, "#app-id")
        .await
        .expect("a good capture");

    let seen = transport.channel().seen();
    assert_eq!(
        seen,
        vec![StepRequest::CaptureCredential {
            slot: "app_id".to_string(),
            selector: "#app-id".to_string(),
            recipient: HOST_KEY.to_string(),
        }],
    );
}

/// A host that returns the plaintext where a marker belongs. The bug this
/// exists to catch is one line deep and hands the model the secret through the
/// one type designed to redeem nothing.
struct LeakyVault(Arc<FakeVault>);

#[async_trait]
impl CaptureVault for LeakyVault {
    fn recipient(&self) -> &str {
        HOST_KEY
    }
    async fn open(&self, sealed: &SealedCapture) -> Result<String, StepError> {
        self.0.unseal(sealed)
    }
    async fn store(&self, slot: Slot, value: &str) -> Result<String, StepError> {
        self.0.put(slot, value);
        // The mistake: a "marker" built from the value.
        Ok(format!("sealed:{value}"))
    }
}

#[tokio::test]
async fn a_marker_that_carries_the_value_is_refused_rather_than_handed_back() {
    let driver = FakeDriver::yielding(&[(Slot::ClientSecret, "Iv1.a1b2c3d4e5f6")]);
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new()).capturing(
        Box::new(LeakyVault(Arc::clone(&vault))),
        &[Slot::ClientSecret],
    );

    let error = transport
        .capture_credential(Slot::ClientSecret, "#secret")
        .await
        .expect_err("the receipt would have carried the secret");

    assert_eq!(error, CaptureError::Step(StepError::Transport));
    // The value was legitimately sealed on the way through; it is the receipt
    // that is refused, and refusing it is what keeps it away from the model.
    assert!(vault.holds("Iv1.a1b2c3d4e5f6"));
}

#[tokio::test]
async fn a_downloaded_key_is_sealed_the_same_way() {
    let driver = FakeDriver::yielding(&[(Slot::PrivateKey, PEM)]);
    let vault = Arc::new(FakeVault::default());
    let transport = ExtensionTransport::new(driver, Vec::new()).capturing(
        Box::new(VaultHandle(Arc::clone(&vault))),
        &[Slot::PrivateKey],
    );

    let report = run_capture_steps(
        &transport,
        &[CaptureStep::Download {
            slot: Slot::PrivateKey,
            content_type: "application/x-pem-file".to_string(),
        }],
    )
    .await
    .expect("a PEM, sealed and admitted");

    assert!(report.is_complete());
    assert_eq!(report.sealed[0].slot(), Slot::PrivateKey);
    assert!(vault.holds(PEM), "the key never reached the vault");
}
