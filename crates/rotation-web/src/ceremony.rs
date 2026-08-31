//! The capture half of the tool boundary (ADR 0082 §3).
//!
//! Rotation's [`BrowserTransport`] moves a credential *toward* a page: name a
//! reference, it gets typed in, and no signature can carry a value back. A
//! ceremony runs the other way. The provider mints the material and the page is
//! where it appears, so the run has to move a secret *from* an untrusted page
//! into the vault — the first tool in the system that does.
//!
//! That direction is more dangerous, so it is a separate trait rather than four
//! more methods on the rotation surface. ADR 0076's boundary stays exactly the
//! size it was, and a transport that only drives rotations does not grow the
//! ability to capture.
//!
//! Three properties hold this together, and each is structural rather than a
//! check someone remembers to write:
//!
//! - **No method returns a value.** A capture answers with a
//!   [`CaptureDigest`] — ADR 0005's `ConnectionRef` shape, naming which slot
//!   was filled and redeeming nothing. The model sees progress, never material.
//! - **The ledger lives with the plaintext.** [`DeclaredSlots::admit`] checks
//!   declaration, double-fill and shape *together*, on purpose, so they cannot
//!   drift apart. Only the transport ever holds the value, so only the
//!   transport can run that check — which is why the ledger is behind the trait
//!   instead of in the executor. An executor holding a copy would be a second
//!   answer to "was this slot declared", and the two would eventually disagree.
//! - **A refusal ends the run.** Every [`CaptureRefusal`] aborts. ADR 0082 §3:
//!   the alternative is sealing a login page as a signing key and finding out
//!   months later, during a backup.

use async_trait::async_trait;
use opensesame_ceremony::{CaptureDigest, CaptureRefusal, Slot};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::tools::{BrowserTransport, StepError};

/// Why a capture did not happen.
///
/// Two kinds, kept apart because they mean different things to the run. A
/// [`StepError`] is the page not cooperating — a slow render, a selector that
/// matched nothing — and a runner may reasonably wait and ask again. A
/// [`CaptureRefusal`] is the value being inadmissible, and there is nothing to
/// retry: asking the same page for the same field will produce the same
/// non-key. Collapsing them into one type would invite a retry loop around a
/// verdict that will never change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "reason")]
pub enum CaptureError {
    #[error("the page did not yield the capture: {0}")]
    Step(#[from] StepError),
    #[error("the value was refused: {0}")]
    Refused(#[from] CaptureRefusal),
}

impl CaptureError {
    /// Whether asking again could plausibly answer differently.
    ///
    /// Enumerated rather than "any [`StepError`]", because two of them are
    /// answers rather than accidents. A refused navigation is the egress
    /// policy speaking and will refuse identically forever; a challenge is the
    /// relying party asking for a human, and a runner that retried it would
    /// spin against a gate that exists to stop exactly that — and would look
    /// like an attack from the other side.
    ///
    /// The other three are timing: a page that has not rendered, a step that
    /// ran out of time, a driver that went away. Those are worth another
    /// attempt. A [`CaptureRefusal`] never is — it is a verdict on what the
    /// page contained, so a retry re-reads the same wrong thing.
    #[must_use]
    pub const fn is_retryable(self) -> bool {
        match self {
            Self::Step(step) => matches!(
                step,
                StepError::Timeout | StepError::NoSuchElement | StepError::Transport
            ),
            Self::Refused(_) => false,
        }
    }
}

/// One capture, as the recipe writes it.
///
/// Deliberately two variants rather than one with an optional selector. The
/// motivating credential — a GitHub App's private key — is never in the DOM: it
/// arrives as a file the browser downloads when the app is created. A step IR
/// that only knew about fields would have no way to say so, and the recipe
/// would end up expressing "read the key" as some selector that cannot work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "from")]
pub enum CaptureStep {
    /// The value is rendered in the page.
    Field { slot: Slot, selector: String },
    /// The provider delivered a file, and it must arrive as `content_type`.
    ///
    /// The content type is declared by the recipe and checked on arrival: a
    /// download that comes back as `text/html` is an error page where a key was
    /// expected, and sealing it would produce the months-later failure above.
    Download { slot: Slot, content_type: String },
}

impl CaptureStep {
    #[must_use]
    pub const fn slot(&self) -> Slot {
        match self {
            Self::Field { slot, .. } | Self::Download { slot, .. } => *slot,
        }
    }
}

/// The capture verbs, on top of rotation's transport.
///
/// A `CeremonyTransport` is a `BrowserTransport` that can additionally seal
/// what a page produced. The supertrait bound is not decoration: a ceremony
/// navigates, waits and submits its way to the page where the material appears,
/// so it needs all of rotation's verbs and these as well.
#[async_trait]
pub trait CeremonyTransport: BrowserTransport {
    /// Declared slots this run has not filled yet.
    ///
    /// The executor's only view of the ledger, and it is read-only on purpose:
    /// progress is observable without anything outside the transport being able
    /// to declare a slot or mark one filled.
    async fn outstanding(&self) -> Vec<Slot>;

    /// Read the node at `selector`, check it against the slot, and seal it.
    ///
    /// All three happen inside the implementation, against the value it is
    /// holding, and the digest comes back from the sealed blob rather than from
    /// the plaintext.
    ///
    /// # Errors
    ///
    /// [`CaptureError::Step`] if the page would not yield the node,
    /// [`CaptureError::Refused`] if what it yielded is not admissible.
    async fn capture_credential(
        &self,
        slot: Slot,
        selector: &str,
    ) -> Result<CaptureDigest, CaptureError>;

    /// Take the file the page just delivered and seal it into `slot`.
    ///
    /// # Errors
    ///
    /// As [`Self::capture_credential`], plus
    /// [`CaptureRefusal::WrongContentType`] when the download did not arrive as
    /// the recipe declared.
    async fn capture_download(
        &self,
        slot: Slot,
        content_type: &str,
    ) -> Result<CaptureDigest, CaptureError>;
}

/// What a sequence of capture steps produced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureReport {
    /// One digest per step that completed, in order. Never a value.
    pub sealed: Vec<CaptureDigest>,
    /// Declared slots still empty when the run stopped.
    ///
    /// Reported rather than inferred from `sealed.len()`: a ceremony that
    /// sealed three of four things has to say which one is missing, and ADR
    /// 0082 §6 is explicit that a partial capture is not a success.
    pub outstanding: Vec<Slot>,
}

impl CaptureReport {
    /// Whether every declared slot was filled.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.outstanding.is_empty()
    }
}

/// Run a recipe's capture steps in order, stopping at the first refusal.
///
/// Stopping is the point. A run that carried on past a refused capture would
/// reach the end with a slot empty and a receipt that says so somewhere in the
/// middle, and the failure would surface at first use rather than here.
///
/// # Errors
///
/// The first [`CaptureError`] any step produced. Steps before it are sealed and
/// stay sealed — unwinding a seal is not something this layer can do, and the
/// ledger inside the transport is what records how far the run got.
pub async fn run_capture_steps<T>(
    transport: &T,
    steps: &[CaptureStep],
) -> Result<CaptureReport, CaptureError>
where
    T: CeremonyTransport + ?Sized,
{
    let mut sealed = Vec::with_capacity(steps.len());
    for step in steps {
        let digest = match step {
            CaptureStep::Field { slot, selector } => {
                transport.capture_credential(*slot, selector).await?
            }
            CaptureStep::Download { slot, content_type } => {
                transport.capture_download(*slot, content_type).await?
            }
        };
        sealed.push(digest);
    }
    Ok(CaptureReport {
        sealed,
        outstanding: transport.outstanding().await,
    })
}
