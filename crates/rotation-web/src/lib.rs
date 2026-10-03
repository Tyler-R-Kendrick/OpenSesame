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
//!
//! Since ADR 0150 §6.3 one more thing lives here, for **login only**:
//! `LoginSubstitution`. A recipe may declare the one field of the one POST
//! its login form submits; the runner then types a surrogate (`osr_…`) into
//! the page instead of the password, and at its egress boundary
//! `ArmedSubstitution::egress` recognizes the surrogate as the whole value
//! of that field, strips it and re-places the credential with the body
//! format's own encoder — never a find-and-replace. A surrogate anywhere else
//! is refused, and a misdirected or misplaced one is a `surrogate.*`
//! tripwire. A failed substituted login falls back to CDP fill and never
//! retries substitution (`AfterSubstitution`); responses are scrubbed of the
//! credential before the model reads them (`ResponseScrub`). A password-set
//! field can never be declared, so rotation keeps ADR 0076 §6 unchanged.
//! `SurrogateLoginTransport` is the additive runner contract, a supertrait
//! of [`BrowserTransport`] like [`CeremonyTransport`], and
//! `run_surrogate_login` is its ordering.
//!
//! **Login substitution is an optional plugin feature** (ADR 0150 §7): the
//! `login-surrogate` cargo feature, off by default, so none of it — the
//! module, its re-exports, its dependencies — is in a default build. The
//! surrogate-proxy plugin binary compiles it in, and even then a declaration
//! is armed only while that plugin's switch is on: `LoginRoad::choose` takes
//! the recipe's opt-in and the plugin's `PluginState` and answers either an
//! armed substitution or CDP fill. Login substitution has no switch of its
//! own; it shares `surrogate-proxy`'s, so turning that plugin off in
//! Settings, with `opensesame plugins disable`, or with
//! `OPENSESAME_PLUGIN_SURROGATE_PROXY=off` turns login substitution off too.

mod capture;
mod ceremony;
mod executor;
mod extension;
pub mod hooks;
#[cfg(feature = "login-surrogate")]
mod login_surrogate;
pub mod recipe_doc;
mod tools;

pub use capture::{
    classify, solve_mask, strip_targets, ActionRecord, Classification, FieldSnapshot, FrameRecord,
    ThoughtRecord,
};
pub use ceremony::{
    run_capture_steps, CaptureError, CaptureReport, CaptureStep, CaptureVault, CeremonyTransport,
    SealedCapture,
};
pub use executor::{
    run_change_password, ActionStep, BlockedReason, CandidateVault, ChangePasswordRecipe,
    ExecutorError, RunOutcome, RunReport,
};
pub use extension::{ExtensionTransport, StepChannel, StepOutcome, StepRequest};
pub use hooks::{
    host_run, run_capture_steps_hooked, run_change_password_hooked, HookSession, HookedTransport,
    HostedRunError, RunRequest,
};
#[cfg(feature = "login-surrogate")]
pub use login_surrogate::{
    run_login, run_surrogate_login, AfterSubstitution, ArmedSubstitution, CdpOnly, DeclareError,
    Egress, EgressReport, FallbackReason, LoginOrigin, LoginOutcome, LoginReport, LoginRequest,
    LoginRoad, LoginSubstitution, LoginSubstitutionSpec, LoginSurrogate, LoginVia, ParkReason,
    Refusal, RefusalCode, ResponseScrub, Substituted, SubstitutionPurpose, SurrogateLoginRecipe,
    SurrogateLoginTransport, REDACTED, SUBSTITUTION_PLUGIN, SURROGATE_HEX_LEN, SURROGATE_MARKER,
};
pub use tools::{
    AdmittedFrame, BrowserTransport, CandidateHandle, CredentialRef, Filled, Presence, RedactedDom,
    StepError, Verified,
};
