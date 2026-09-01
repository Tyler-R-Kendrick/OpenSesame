//! Web-login rotation: the step IR, the tool boundary, and the ordering that
//! must not be rearranged (ADR 0076).
//!
//! Two things live here and nothing else does — plus, since ADR 0082, the same
//! boundary read backwards: [`CeremonyTransport`] adds the capture verbs a
//! registration ceremony needs, as a supertrait rather than as more methods
//! here, so rotation's surface stays the size ADR 0076 fixed it at.
//!
//! [`BrowserTransport`] is the sandbox's tool surface as a trait, and its shape
//! is the security property: **no method returns a credential value.** An agent
//! driving a run can say which credential and where it goes; there is no
//! signature that can carry one back. Implementations are swappable by design —
//! the contract is transport-level, so a remote CDP sandbox and a local browser
//! extension are alternatives rather than forks (ADR 0076 §8). No browser
//! driver and no model client is a dependency of this crate.
//!
//! [`run_change_password`] is the ordering, in one function, so it can be read
//! and tested as one thing:
//!
//! ```text
//! generate candidate
//!   -> seal to vault
//!   -> WAIT for backup acknowledgement
//!   -> fill
//!   -> [critical] assert candidate present  [FAIL-CLOSED]
//!   ->            submit
//!   -> verify by fresh login
//!   -> promote
//! ```
//!
//! The two edges that are the difference between a rotation and a lockout are
//! the wait and the assertion, and the critical section is what stops a handoff
//! landing between the assertion and the submit and voiding it.

mod capture;
mod ceremony;
mod executor;
mod extension;
mod tools;

pub use capture::{
    classify, solve_mask, strip_targets, ActionRecord, Classification, FieldSnapshot, FrameRecord,
    ThoughtRecord,
};
pub use ceremony::{
    run_capture_steps, CaptureError, CaptureReport, CaptureStep, CeremonyTransport,
};
pub use executor::{
    run_change_password, ActionStep, BlockedReason, CandidateVault, ChangePasswordRecipe,
    ExecutorError, RunOutcome, RunReport,
};
pub use extension::{ExtensionTransport, StepChannel, StepOutcome, StepRequest};
pub use tools::{
    AdmittedFrame, BrowserTransport, CandidateHandle, CredentialRef, Filled, Presence, RedactedDom,
    StepError, Verified,
};
