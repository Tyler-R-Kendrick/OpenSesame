//! Connector registration ceremonies (ADR 0082).
//!
//! `OpenSesame`'s value is gated behind setup only a developer can complete:
//! register a GitHub App, install it on the org, then set the backup target.
//! This crate is the vocabulary for automating that — and the first thing it
//! encodes is what *not* to automate.
//!
//! **The registration form is not the hard part.** For GitHub it is already
//! solved: `apps/gateway/src/routes/github_app.rs` implements the App Manifest
//! flow, so nobody fills fifteen fields and nobody downloads a `.pem`. Driving
//! a browser to fill a form a provider offers an endpoint for would be more
//! fragile, more dangerous, and would discard a supported path. So
//! [`tier::resolve`] never sends registration to a browser when a provider
//! publishes an endpoint for it, and ADR 0082 §1 calls a run that does so a bug
//! rather than a preference.
//!
//! What is actually hard is the orchestration: having an account, being signed
//! in as the right identity, knowing which org to pick, and knowing that
//! installing is a separate step from registering. That is what a ceremony
//! automates.
//!
//! Four things here carry the weight:
//!
//! - [`tier`] — the ladder, and the rule that a provider's own flow always
//!   wins for the part it covers.
//! - [`capture`] — typed slots with fail-closed shapes. This is the inverse of
//!   rotation's fill: the agent names *which slot* and *where the value is*,
//!   never receiving it, and a slot the recipe did not declare cannot be
//!   captured at all. A model free to choose what to capture could seal a
//!   page's session cookie as a client secret.
//! - [`refusal`] — ADR 0082 §5's five refusals as types, reachable only
//!   through [`refusal::Guard::admit`], so a step that would break one cannot
//!   be issued.
//! - [`outcome`] — success means a round trip, not a green form. A
//!   [`outcome::Completion`] cannot be constructed without the proof.
//!
//! Nothing here does I/O and nothing here holds a credential value. The
//! controller that reads a node already has the plaintext and is about to seal
//! it; this crate tells it whether it may, and hands back a digest that
//! redeems nothing.

pub mod capture;
pub mod outcome;
pub mod refusal;
pub mod tier;

pub use capture::{
    check_shape, CaptureDigest, CaptureRefusal, DeclaredSlots, Shape, Slot, MAX_PEM_BYTES,
    MAX_TOKEN_CHARS, MIN_TOKEN_CHARS,
};
pub use outcome::{Completion, GrantedPermissions, Incomplete, RoundTrip};
pub use refusal::{Act, Consent, Guard, Presence, Refusal};
pub use tier::{resolve, Phase, ProviderCapability, Tier};
