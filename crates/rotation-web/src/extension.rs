use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use opensesame_session_observe::{admit_frame, LayoutEpoch, MaskManifest};

use crate::capture::FieldSnapshot;
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
}

/// What a driver reports back.
///
/// No variant carries a credential value, which is the same property the
/// [`BrowserTransport`] trait has — restated on the wire, because a channel is
/// exactly where a convenient extra field gets added.
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
}

impl<C: StepChannel> ExtensionTransport<C> {
    #[must_use]
    pub const fn new(channel: C, fields: Vec<FieldSnapshot>) -> Self {
        Self { channel, fields }
    }

    /// Replace the field inventory after a navigation.
    pub fn observed(&mut self, fields: Vec<FieldSnapshot>) {
        self.fields = fields;
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
