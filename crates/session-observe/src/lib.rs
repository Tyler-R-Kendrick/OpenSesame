//! Live session observation and control handoff (ADR 0081).
//!
//! When an agent drives a browser through somebody's account — the ADR 0076
//! T4 tier of web-login rotation — the person whose account it is should be
//! able to watch it happen, see what the model believed it was doing, and take
//! the page back. This crate is the value-blind vocabulary for that, and does
//! no I/O: the gateway supplies transport and persistence, the runner supplies
//! capture and sealing.
//!
//! Three pieces, deliberately independent of one another:
//!
//! - [`ControlLease`] — the handoff machine. Exactly one actor drives, the
//!   agent is provably parked before a human touches the page, and the span
//!   between a candidate's presence assertion and its submit cannot be
//!   interrupted. **Autonomy is never resumed by a timeout**: a lease that
//!   expires parks the run.
//! - [`admit_frame`] — the fail-closed gate a screencast frame passes before it
//!   is encoded. Live capture is asynchronous, so a mask solved one layout ago
//!   is not a mask, and an unprovable frame is dropped rather than sent.
//! - [`authorize_attach`] — who may watch and who may drive. The owner, and
//!   nobody else: not a delegate, not an operator, and not an agent surface.
//!
//! What is *not* here, on purpose: any type able to carry a credential value.
//! [`SealedPayload`] takes ciphertext and returns ciphertext, so the gateway's
//! courier role is a shape rather than a promise, and [`UntrustedText`] holds
//! model-authored prose in a wrapper that refuses to render itself.

mod lease;
mod stream;
mod viewer;

pub use lease::{
    ControlError, ControlLease, ControlState, CriticalExit, HandoffOutcome, Quiescence, Reassertion,
};
pub use stream::{
    admit_frame, FrameDrop, Lane, LayoutEpoch, MaskManifest, ObservationEvent, SealedPayload, Seq,
    UntrustedText, MAX_THOUGHT_CHARS,
};
pub use viewer::{authorize_attach, AttachRefusal, Attachment, StepUp, ViewerRelation};
