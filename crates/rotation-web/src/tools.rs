use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use opensesame_session_observe::{LayoutEpoch, MaskManifest};

/// Names a credential without being one.
///
/// ADR 0005's handle shape at DOM scale: the agent says *which* credential and
/// *where it goes*, and a deterministic controller resolves it. The struct has
/// one field and it is an identifier, so there is nowhere for a value to sit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialRef(String);

impl CredentialRef {
    #[must_use]
    pub fn new(reference: impl Into<String>) -> Self {
        Self(reference.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A generated candidate, as a handle.
///
/// `generate_candidate` returns one of these rather than a password. The value
/// exists only inside the controller and the vault.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateHandle(String);

impl CandidateHandle {
    #[must_use]
    pub fn new(handle: impl Into<String>) -> Self {
        Self(handle.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The reference a fill step names to write this candidate.
    #[must_use]
    pub fn as_credential_ref(&self) -> CredentialRef {
        CredentialRef::new(self.0.clone())
    }
}

/// Whether a fill landed. Not what landed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Filled {
    Ok,
    /// The selector matched nothing, or matched something that cannot take a
    /// value.
    NoSuchField,
}

/// Whether the field holds the value the run believes it holds.
///
/// The fail-closed assertion ADR 0076 constraint 3 requires. `Absent` and
/// `Mismatch` are kept apart because they mean different things to a person
/// reading a parked run: nothing was typed, versus something else is there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Presence {
    Present,
    Absent,
    Mismatch,
}

/// The result of proving a credential works, by using it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verified {
    Works,
    Rejected,
    /// The site answered in a way that proves nothing. Never treated as either
    /// outcome — ADR 0076 constraint 5 parks it.
    Indeterminate,
}

/// A DOM read with credential values already gone.
///
/// Constructed only by a transport, from a pipeline that strips before it
/// serializes. There is no constructor taking an unredacted string, so a
/// caller cannot produce one by promising it redacted the input itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedactedDom {
    text: String,
    epoch: LayoutEpoch,
}

impl RedactedDom {
    /// Called by a transport that has already stripped values at capture.
    #[must_use]
    pub fn from_stripped(text: String, epoch: LayoutEpoch) -> Self {
        Self { text, epoch }
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub const fn epoch(self_: &Self) -> LayoutEpoch {
        self_.epoch
    }
}

/// A frame that passed [`opensesame_session_observe::admit_frame`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdmittedFrame {
    bytes: Vec<u8>,
    epoch: LayoutEpoch,
}

impl AdmittedFrame {
    #[must_use]
    pub fn new(bytes: Vec<u8>, epoch: LayoutEpoch) -> Self {
        Self { bytes, epoch }
    }

    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub const fn epoch(&self) -> LayoutEpoch {
        self.epoch
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum StepError {
    #[error("the page did not reach the expected state in time")]
    Timeout,
    #[error("the selector matched nothing")]
    NoSuchElement,
    #[error("navigation was refused or redirected off the target origin")]
    Navigation,
    #[error("the relying party presented a challenge")]
    Challenge,
    #[error("the runner is unavailable")]
    Transport,
}

/// The sandbox's tool surface, as a trait.
///
/// **There is no method that returns a credential value.** That is the whole
/// point, and it is enforced here rather than by a check somewhere: the shape
/// of this trait is the shape of what a driving agent can ask for, and no
/// signature in it can carry a secret back. `fill_credential` takes a reference
/// and answers whether it landed; there is no `read_field_value`, in the same
/// structural sense as `wit/connector/world.wit` having no `secrets.get`.
///
/// Implementations are swappable by design (ADR 0076 §8): the contract is
/// transport-level, so a remote CDP sandbox and a local browser extension are
/// alternatives rather than forks.
#[async_trait]
pub trait BrowserTransport: Send + Sync {
    async fn navigate(&self, url: &str) -> Result<(), StepError>;

    async fn wait_for(&self, selector: &str) -> Result<(), StepError>;

    /// Resolve `reference` and type it into `selector`. Returns whether it
    /// landed, never what landed.
    async fn fill_credential(
        &self,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<Filled, StepError>;

    /// Whether `selector` holds the value `reference` names.
    ///
    /// Answered by the controller, which knows both, rather than by reading the
    /// field and handing the answer to a comparison somewhere else.
    async fn assert_present(
        &self,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<Presence, StepError>;

    async fn submit(&self, selector: &str) -> Result<(), StepError>;

    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError>;

    /// Capture a frame, but only if a mask exists for the layout it was
    /// composited under.
    async fn screenshot_redacted(
        &self,
        mask: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError>;

    /// Prove the credential works by using it — a fresh login, never a probe of
    /// the old value (ADR 0076 §9).
    async fn verify_login(&self, reference: &CredentialRef) -> Result<Verified, StepError>;
}
