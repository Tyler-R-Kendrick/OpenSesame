//! A2H (Agent-to-Human) v1.0 — the channel a blocked run reaches a person on.
//!
//! `OpenSesame` is an A2H *client*, never a gateway. It hands an intent to
//! whichever gateway the deployment configures — Twilio's, or a self-hosted one
//! — and that gateway owns channel selection, failover, quiet hours and
//! evidence collection. Which is the reason to use the protocol at all: the
//! alternative is a separate integration for SMS, email, `WhatsApp`, push and
//! voice, each with its own retry and state handling, inside a product whose
//! job is authorization.
//!
//! It is also one subscriber among several. A blocked run publishes on the
//! `agent.*` feed (`crates/agent-events`), and A2H is a delivery mode for that
//! feed alongside Standard Webhooks — not a private path from the runner to a
//! phone. Anyone wiring their own alerting subscribes to the same fact.
//!
//! Three things here are worth reading before using it:
//!
//! - [`intent::ResponseAuthority`] — an A2H reply may only *narrow* authority.
//!   It can stop a run; it can never grant control or resume autonomy, and no
//!   assurance level changes that.
//! - [`DeliveryOutcome`] — `ERR.QUIET_HOURS` means *not delivered*. Recording it
//!   as sent is how a blocked run's deadline passes with nobody told.
//! - [`verify`] — nothing the gateway posts back is taken on trust.

mod envelope;
pub mod intent;
pub mod verify;

pub use envelope::{
    A2hMessage, A2hResponse, AssuranceConfig, AssuranceLevel, CallbackConfig, ChannelBinding,
    Decision, ErrorCode, Evidence, FallbackChannel, GatewayCapabilities, IntentType,
    InteractionState, RenderContent, A2H_VERSION, MAX_BODY_CHARS, MAX_TITLE_CHARS, MAX_TTL_SEC,
    MIN_TTL_SEC,
};
pub use intent::{
    assurance_for, authority_for, intent_for, message_for, AuthorityError, IntentContext,
    ResponseAuthority,
};
pub use verify::{
    parse_signature, sign, verify_callback, ExpectedReply, SignatureHeader, VerifyError,
    SECRET_PREFIX, SIGNATURE_VERSION, TIMESTAMP_TOLERANCE_SECONDS,
};

/// What happened to one intent hand-off.
///
/// `Suppressed` exists because the alternative is a silent failure with a
/// deadline attached. A gateway that returns `ERR.QUIET_HOURS` has **not**
/// delivered the message; if that is recorded as "notified", the run's response
/// window expires, the run parks for good, and the person it was waiting for was
/// never told. So suppression is its own outcome, it is retried when the window
/// opens, and until then the run's own state says nobody has heard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryOutcome {
    /// The gateway accepted the intent for delivery.
    Delivered,
    /// Held by a policy at the gateway — quiet hours, rate limiting. Not
    /// delivered, and not a failure to give up on.
    Suppressed,
    /// The gateway refused it in a way retrying could fix.
    Retryable,
    /// The gateway refused it in a way retrying cannot fix.
    Permanent,
}

impl DeliveryOutcome {
    /// How to treat a protocol error code.
    #[must_use]
    pub const fn for_error(code: ErrorCode) -> Self {
        match code {
            ErrorCode::QuietHours | ErrorCode::RateLimited => Self::Suppressed,
            ErrorCode::ChannelUnavailable | ErrorCode::DeliveryFailed => Self::Retryable,
            ErrorCode::Expired
            | ErrorCode::InvalidRequest
            | ErrorCode::InvalidPrincipal
            | ErrorCode::Conflict
            | ErrorCode::ReplayRejected => Self::Permanent,
        }
    }

    /// Whether the person this was for can be assumed to have heard.
    ///
    /// The one question a caller must not get wrong: only [`Self::Delivered`]
    /// answers yes.
    #[must_use]
    pub const fn reached_someone(self) -> bool {
        matches!(self, Self::Delivered)
    }
}
