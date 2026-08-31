//! The local-runner transport (ADR 0079 §4).
//!
//! Two properties are the point, and both are about not trusting the driver:
//! an outcome of the wrong kind is a protocol violation rather than something
//! to coerce, and a frame is admitted on this side from what was *asked* to be
//! masked — never from the driver's assurance that its picture is fine.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use opensesame_rotation_web::{
    BrowserTransport, CredentialRef, ExtensionTransport, FieldSnapshot, Filled, Presence,
    StepChannel, StepError, StepOutcome, StepRequest, Verified,
};
use opensesame_session_observe::{LayoutEpoch, MaskManifest};

/// A shared record of what actually crossed the channel.
///
/// The test holds one handle and the channel holds another, so nothing
/// test-only has to be exposed on the transport itself.
type Seen = Arc<Mutex<Vec<StepRequest>>>;

struct Scripted {
    outcome: StepOutcome,
    seen: Seen,
}

impl Scripted {
    fn new(outcome: StepOutcome) -> (Self, Seen) {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                outcome,
                seen: Arc::clone(&seen),
            },
            seen,
        )
    }
}

#[async_trait]
impl StepChannel for Scripted {
    async fn dispatch(&self, request: StepRequest) -> Result<StepOutcome, StepError> {
        self.seen.lock().unwrap().push(request);
        Ok(self.outcome.clone())
    }
}

struct Silent;

#[async_trait]
impl StepChannel for Silent {
    async fn dispatch(&self, _request: StepRequest) -> Result<StepOutcome, StepError> {
        Err(StepError::Transport)
    }
}

fn field(selector: &str, input_type: &str) -> FieldSnapshot {
    FieldSnapshot {
        selector: selector.into(),
        input_type: Some(input_type.into()),
        autocomplete: None,
        is_credential_target: false,
        has_box: true,
    }
}

fn fields() -> Vec<FieldSnapshot> {
    vec![field("#user", "text"), field("#new", "password")]
}

#[tokio::test]
async fn a_fill_sends_a_reference_and_never_a_value() {
    let (channel, seen) = Scripted::new(StepOutcome::Filled { filled: Filled::Ok });
    let transport = ExtensionTransport::new(channel, fields());
    let outcome = transport
        .fill_credential(&CredentialRef::new("cand:1"), "#new")
        .await
        .unwrap();
    assert_eq!(outcome, Filled::Ok);

    // What crossed the channel: a name and a place. The driver resolves it,
    // because in the local model the driver is the one holding the vault.
    let crossed = seen.lock().unwrap();
    assert_eq!(
        crossed[0],
        StepRequest::FillCredential {
            reference: "cand:1".into(),
            selector: "#new".into(),
        }
    );
    let encoded = serde_json::to_string(&crossed[0]).unwrap();
    assert!(!encoded.contains("hunter2"), "{encoded}");
}

#[tokio::test]
async fn an_outcome_of_the_wrong_kind_is_refused_rather_than_coerced() {
    // A driver answering a fill with a screenshot is a protocol violation.
    let (channel, _seen) = Scripted::new(StepOutcome::Frame {
        image: vec![1, 2, 3],
        epoch: 1,
        masked_boxes: 1,
    });
    let transport = ExtensionTransport::new(channel, fields());
    assert_eq!(
        transport
            .fill_credential(&CredentialRef::new("cand:1"), "#new")
            .await,
        Err(StepError::Transport)
    );
}

#[tokio::test]
async fn an_unreadable_presence_answer_is_never_a_pass() {
    // This is the check standing between a rotation and a lockout, so anything
    // but a clear answer is refused.
    let (channel, _seen) = Scripted::new(StepOutcome::Done);
    let transport = ExtensionTransport::new(channel, fields());
    assert_eq!(
        transport
            .assert_present(&CredentialRef::new("cand:1"), "#new")
            .await,
        Err(StepError::Transport)
    );
}

#[tokio::test]
async fn a_driver_that_goes_quiet_stops_the_run() {
    let transport = ExtensionTransport::new(Silent, fields());
    assert_eq!(
        transport.navigate("https://example.com").await,
        Err(StepError::Transport)
    );
    assert_eq!(
        transport
            .assert_present(&CredentialRef::new("c"), "#new")
            .await,
        Err(StepError::Transport)
    );
}

#[tokio::test]
async fn a_dom_read_tells_the_driver_exactly_what_to_strip() {
    let (channel, seen) = Scripted::new(StepOutcome::Dom {
        text: "<form></form>".into(),
        epoch: 3,
    });
    let transport = ExtensionTransport::new(channel, fields());
    let dom = transport.read_dom_redacted().await.unwrap();
    assert_eq!(dom.text(), "<form></form>");

    let crossed = seen.lock().unwrap();
    let StepRequest::ReadDomRedacted { strip } = &crossed[0] else {
        panic!("expected a dom read");
    };
    // Both fields: a username is account data and does not belong in a model's
    // context either.
    assert_eq!(strip, &vec!["#user".to_string(), "#new".to_string()]);
}

#[tokio::test]
async fn a_frame_is_admitted_here_not_asserted_by_the_driver() {
    let epoch = LayoutEpoch(7);
    // One field needs masking (#new), and the driver says it covered one.
    let (channel, _seen) = Scripted::new(StepOutcome::Frame {
        image: vec![9, 9, 9],
        epoch: 7,
        masked_boxes: 1,
    });
    let transport = ExtensionTransport::new(channel, fields());
    let frame = transport
        .screenshot_redacted(MaskManifest::solved(epoch, 1, 1))
        .await
        .unwrap();
    assert!(frame.is_some());
}

#[tokio::test]
async fn a_driver_that_covered_nothing_produces_no_frame() {
    let epoch = LayoutEpoch(7);
    // Honest driver: "I masked zero boxes." One was required, so the frame is
    // dropped rather than shown.
    let (channel, _seen) = Scripted::new(StepOutcome::Frame {
        image: vec![9, 9, 9],
        epoch: 7,
        masked_boxes: 0,
    });
    let transport = ExtensionTransport::new(channel, fields());
    assert!(transport
        .screenshot_redacted(MaskManifest::solved(epoch, 1, 1))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_frame_from_a_different_generation_is_dropped() {
    // The driver captured a later layout than the one the mask was solved for.
    let (channel, _seen) = Scripted::new(StepOutcome::Frame {
        image: vec![9],
        epoch: 9,
        masked_boxes: 1,
    });
    let transport = ExtensionTransport::new(channel, fields());
    assert!(transport
        .screenshot_redacted(MaskManifest::solved(LayoutEpoch(7), 1, 1))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn the_wire_shapes_carry_no_field_that_could_hold_a_value() {
    // Restated on the wire, because a channel is exactly where a convenient
    // extra field gets added.
    for outcome in [
        StepOutcome::Done,
        StepOutcome::Filled { filled: Filled::Ok },
        StepOutcome::Presence {
            presence: Presence::Present,
        },
        StepOutcome::Verified {
            verified: Verified::Works,
        },
        StepOutcome::Failed {
            error: StepError::Challenge,
        },
    ] {
        let encoded = serde_json::to_string(&outcome).unwrap();
        for forbidden in ["\"value\"", "\"password\"", "\"secret\"", "\"token\""] {
            assert!(!encoded.contains(forbidden), "{encoded}");
        }
    }
}
