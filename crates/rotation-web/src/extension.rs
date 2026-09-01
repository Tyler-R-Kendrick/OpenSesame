use std::sync::Mutex;

use async_trait::async_trait;
use opensesame_ceremony::{CaptureDigest, DeclaredSlots, Slot};
use serde::{Deserialize, Serialize};

use opensesame_session_observe::{admit_frame, LayoutEpoch, MaskManifest};

use crate::capture::FieldSnapshot;
use crate::ceremony::{CaptureError, CaptureVault, CeremonyTransport, SealedCapture};
use crate::tools::{
    AdmittedFrame, BrowserTransport, CredentialRef, Filled, Presence, RedactedDom, StepError,
    Verified,
};

/// One step, addressed to a driver that is not in this process.
///
/// Note what crosses and what does not. A fill carries a *reference* and a
/// selector, never a value: the driver resolves it, because in the local model
/// the driver is the one holding the vault. That is ADR 0076 §1 unchanged —
/// the agent says which credential and where, a deterministic controller says
/// what — with the controller on the far side of this channel rather than in
/// the same process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "step")]
pub enum StepRequest {
    Navigate {
        url: String,
    },
    WaitFor {
        selector: String,
    },
    FillCredential {
        reference: String,
        selector: String,
    },
    AssertPresent {
        reference: String,
        selector: String,
    },
    Submit {
        selector: String,
    },
    /// The selectors whose values must be cleared before serializing.
    ReadDomRedacted {
        strip: Vec<String>,
    },
    /// The generation to capture, and the boxes that must be covered.
    ScreenshotRedacted {
        epoch: u64,
        mask_selectors: Vec<String>,
    },
    VerifyLogin {
        reference: String,
    },
    /// Read the node at `selector` and seal it to `recipient`.
    ///
    /// The slot travels so the driver knows what it is being asked for and can
    /// refuse an obviously impossible request; it is not the driver's decision
    /// whether the value fits, and this side checks again on the way in.
    CaptureCredential {
        slot: String,
        selector: String,
        recipient: String,
    },
    /// Take the file the page delivered and seal it to `recipient`.
    CaptureDownload {
        slot: String,
        content_type: String,
        recipient: String,
    },
}

/// What a driver reports back.
///
/// No variant carries a credential *value*. That was literally true when every
/// step moved a credential toward the page, and it stays true now that a
/// ceremony capture moves one the other way: [`StepOutcome::Captured`] carries
/// a [`SealedCapture`], an envelope encrypted to the host's vault key, and the
/// driver cannot open what it just sealed.
///
/// The property is restated on the wire because a channel is exactly where a
/// convenient extra field gets added — and a `plaintext` beside the envelope
/// would be that field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum StepOutcome {
    Done,
    Filled {
        filled: Filled,
    },
    Presence {
        presence: Presence,
    },
    Verified {
        verified: Verified,
    },
    Dom {
        text: String,
        epoch: u64,
    },
    Frame {
        image: Vec<u8>,
        epoch: u64,
        /// How many of the requested boxes the driver actually covered.
        masked_boxes: u32,
    },
    /// A capture, sealed to the host. Ciphertext, and the driver holds no key
    /// for it.
    Captured {
        sealed: SealedCapture,
    },
    Failed {
        error: StepError,
    },
}

/// A way to hand a step to a driver and get its outcome back.
///
/// Deliberately not a websocket, a port, or a queue: the transport does not
/// care how the step reaches the driver. The browser extension claims steps
/// over the Host API and posts outcomes back, which needs no long-lived
/// connection and no new dependency; a different driver could do it another
/// way without this file changing.
#[async_trait]
pub trait StepChannel: Send + Sync {
    /// Hand one step over and wait for its outcome.
    ///
    /// # Errors
    ///
    /// [`StepError::Transport`] when the driver cannot be reached or does not
    /// answer in time. A driver that goes quiet is a driver that stopped, and
    /// the run parks rather than assuming the step landed.
    async fn dispatch(&self, request: StepRequest) -> Result<StepOutcome, StepError>;
}

/// Drives a browser through a [`StepChannel`] — the local-runner shape
/// (ADR 0079 §4).
///
/// One property is worth stating because it is the reason this is not a thin
/// pass-through: **the driver does not get to declare its own frame safe.**
/// It reports how many boxes it covered, and this side builds the mask
/// manifest from what it *asked* to be covered and admits the frame here. A
/// driver that masks nothing and says so honestly produces a dropped frame; a
/// driver that lies produces a frame whose manifest still does not match. The
/// judgement stays on the side that has something to lose.
pub struct ExtensionTransport<C: StepChannel> {
    channel: C,
    /// The fields the current page is known to have, from the last read.
    /// Supplied by the caller because classification is policy, not transport.
    fields: Vec<FieldSnapshot>,
    /// The host's vault, present only when this transport may capture.
    ///
    /// `None` is a transport that drives rotations and nothing else, which is
    /// most of them. Capture is opt-in at construction rather than a flag on
    /// each call, so a rotation runner cannot acquire the ability halfway
    /// through a run.
    vault: Option<Box<dyn CaptureVault>>,
    /// The slots the recipe declared, and which are filled.
    ///
    /// Behind a lock because [`CeremonyTransport`] takes `&self` — the ledger
    /// has to live with the party that holds the plaintext, and that is this
    /// side (ADR 0082 §3).
    slots: Mutex<DeclaredSlots>,
}

impl<C: StepChannel> ExtensionTransport<C> {
    #[must_use]
    pub fn new(channel: C, fields: Vec<FieldSnapshot>) -> Self {
        Self {
            channel,
            fields,
            vault: None,
            slots: Mutex::new(DeclaredSlots::declare(&[])),
        }
    }

    /// Let this transport capture into `vault`, for the slots `declares` names.
    ///
    /// Both at once, deliberately. A vault with no declared slots can capture
    /// nothing and a declaration with no vault has nowhere to put it, so
    /// offering them separately would only create two half-configured states
    /// that fail at the first capture instead of at construction.
    #[must_use]
    pub fn capturing(mut self, vault: Box<dyn CaptureVault>, declares: &[Slot]) -> Self {
        self.vault = Some(vault);
        self.slots = Mutex::new(DeclaredSlots::declare(declares));
        self
    }

    /// Open, admit, store — in that order, which is the point.
    ///
    /// A value that fails the shape or ledger check never reaches
    /// [`CaptureVault::store`]. Writing first and checking after would put a
    /// session cookie in the vault under the name `client_secret` for however
    /// long the check took, and a delete afterwards is not the same as never
    /// having written it.
    async fn admit_sealed(
        &self,
        slot: Slot,
        sealed: &SealedCapture,
    ) -> Result<CaptureDigest, CaptureError> {
        let vault = self.vault.as_ref().ok_or(CaptureError::Step(
            // A transport built without a vault was never meant to capture,
            // and there is nowhere for this to go.
            StepError::Transport,
        ))?;
        if sealed.recipient != vault.recipient() {
            // Addressed to a key we did not offer. Refuse rather than try it:
            // an envelope from somewhere else is not a capture from our run.
            return Err(CaptureError::Step(StepError::Transport));
        }
        let value = vault.open(sealed).await?;
        self.slots
            .lock()
            .map_err(|_| CaptureError::Step(StepError::Transport))?
            .admit(slot, &value)?;
        let marker = vault.store(slot, &value).await?;
        if marker.contains(value.as_str()) {
            // The digest is the one thing here that goes back to the model, and
            // `CaptureVault::store` is documented to return a marker for the
            // sealed blob rather than the plaintext. Documented is not
            // enforced, and a host that got this wrong would hand the model the
            // secret through the very type built to redeem nothing — so it is
            // checked rather than trusted.
            //
            // The value is sealed and stays sealed; what is refused is the
            // receipt. The slot counts as filled, because it was.
            return Err(CaptureError::Step(StepError::Transport));
        }
        Ok(CaptureDigest::of_sealed(slot, marker))
    }

    /// Dispatch a capture step and take the envelope out of the outcome.
    async fn sealed_from(&self, request: StepRequest) -> Result<SealedCapture, CaptureError> {
        match self.channel.dispatch(request).await? {
            StepOutcome::Captured { sealed } => Ok(sealed),
            StepOutcome::Failed { error } => Err(CaptureError::Step(error)),
            // A driver answering a capture with anything else is a protocol
            // violation, not something to coerce into a value.
            _ => Err(CaptureError::Step(StepError::Transport)),
        }
    }

    /// Replace the field inventory after a navigation.
    pub fn observed(&mut self, fields: Vec<FieldSnapshot>) {
        self.fields = fields;
    }

    /// The channel this transport dispatches through.
    ///
    /// Borrowed rather than taken back: a caller that built the channel often
    /// still needs it — to report queue depth, or to assert what was actually
    /// dispatched — and moving it out would end the transport.
    pub const fn channel(&self) -> &C {
        &self.channel
    }

    async fn expect_done(&self, request: StepRequest) -> Result<(), StepError> {
        match self.channel.dispatch(request).await? {
            StepOutcome::Done => Ok(()),
            StepOutcome::Failed { error } => Err(error),
            // A driver answering a navigate with a screenshot is a protocol
            // violation, not a value to coerce into something usable.
            _ => Err(StepError::Transport),
        }
    }
}

#[async_trait]
impl<C: StepChannel> BrowserTransport for ExtensionTransport<C> {
    async fn navigate(&self, url: &str) -> Result<(), StepError> {
        self.expect_done(StepRequest::Navigate {
            url: url.to_string(),
        })
        .await
    }

    async fn wait_for(&self, selector: &str) -> Result<(), StepError> {
        self.expect_done(StepRequest::WaitFor {
            selector: selector.to_string(),
        })
        .await
    }

    async fn fill_credential(
        &self,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<Filled, StepError> {
        match self
            .channel
            .dispatch(StepRequest::FillCredential {
                reference: reference.as_str().to_string(),
                selector: selector.to_string(),
            })
            .await?
        {
            StepOutcome::Filled { filled } => Ok(filled),
            StepOutcome::Failed { error } => Err(error),
            _ => Err(StepError::Transport),
        }
    }

    async fn assert_present(
        &self,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<Presence, StepError> {
        match self
            .channel
            .dispatch(StepRequest::AssertPresent {
                reference: reference.as_str().to_string(),
                selector: selector.to_string(),
            })
            .await?
        {
            StepOutcome::Presence { presence } => Ok(presence),
            StepOutcome::Failed { error } => Err(error),
            // An unreadable answer to the presence assertion is not a pass.
            // This is the check that stands between a rotation and a lockout,
            // so anything but a clear Present is refused.
            _ => Err(StepError::Transport),
        }
    }

    async fn submit(&self, selector: &str) -> Result<(), StepError> {
        self.expect_done(StepRequest::Submit {
            selector: selector.to_string(),
        })
        .await
    }

    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        let strip = crate::capture::strip_targets(&self.fields);
        match self
            .channel
            .dispatch(StepRequest::ReadDomRedacted { strip })
            .await?
        {
            StepOutcome::Dom { text, epoch } => {
                Ok(RedactedDom::from_stripped(text, LayoutEpoch(epoch)))
            }
            StepOutcome::Failed { error } => Err(error),
            _ => Err(StepError::Transport),
        }
    }

    async fn screenshot_redacted(
        &self,
        mask: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        let mask_selectors: Vec<String> = self
            .fields
            .iter()
            .filter(|field| crate::capture::classify(field).mask_in_frame)
            .map(|field| field.selector.clone())
            .collect();
        let requested = u32::try_from(mask_selectors.len()).unwrap_or(u32::MAX);
        let epoch = mask.epoch();
        match self
            .channel
            .dispatch(StepRequest::ScreenshotRedacted {
                epoch: epoch.0,
                mask_selectors,
            })
            .await?
        {
            StepOutcome::Frame {
                image,
                epoch: reported,
                masked_boxes,
            } => {
                // Built from what we asked for and what the driver says it
                // covered — never from a claim that the frame is fine.
                let observed = MaskManifest::solved(LayoutEpoch(reported), requested, masked_boxes);
                if admit_frame(epoch, Some(observed)).is_err() {
                    return Ok(None);
                }
                Ok(Some(AdmittedFrame::new(image, LayoutEpoch(reported))))
            }
            StepOutcome::Failed { error } => Err(error),
            _ => Err(StepError::Transport),
        }
    }

    async fn verify_login(&self, reference: &CredentialRef) -> Result<Verified, StepError> {
        match self
            .channel
            .dispatch(StepRequest::VerifyLogin {
                reference: reference.as_str().to_string(),
            })
            .await?
        {
            StepOutcome::Verified { verified } => Ok(verified),
            StepOutcome::Failed { error } => Err(error),
            _ => Err(StepError::Transport),
        }
    }
}

#[async_trait]
impl<C: StepChannel> CeremonyTransport for ExtensionTransport<C> {
    async fn outstanding(&self) -> Vec<Slot> {
        // Recovered rather than defaulted. An empty list means "nothing still
        // owed", which `CaptureReport::is_complete` reads as success — so
        // answering a poisoned lock with `unwrap_or_default()` would report a
        // finished ceremony for one that captured nothing, in the one
        // direction this whole design exists to prevent. `DeclaredSlots` is
        // two vectors and `admit` pushes last, so the data behind a poisoned
        // lock is still the truth; reading it beats inventing a better answer.
        self.slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .outstanding()
    }

    async fn capture_credential(
        &self,
        slot: Slot,
        selector: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        let recipient = self
            .vault
            .as_ref()
            .ok_or(CaptureError::Step(StepError::Transport))?
            .recipient()
            .to_string();
        let sealed = self
            .sealed_from(StepRequest::CaptureCredential {
                slot: slot.as_str().to_string(),
                selector: selector.to_string(),
                recipient,
            })
            .await?;
        self.admit_sealed(slot, &sealed).await
    }

    async fn capture_download(
        &self,
        slot: Slot,
        content_type: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        let recipient = self
            .vault
            .as_ref()
            .ok_or(CaptureError::Step(StepError::Transport))?
            .recipient()
            .to_string();
        let sealed = self
            .sealed_from(StepRequest::CaptureDownload {
                slot: slot.as_str().to_string(),
                content_type: content_type.to_string(),
                recipient,
            })
            .await?;
        self.admit_sealed(slot, &sealed).await
    }
}
