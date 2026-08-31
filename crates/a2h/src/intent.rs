//! Turning an `agent.*` fact into an A2H intent.
//!
//! Two rules do most of the work here, and both are refusals.
//!
//! **`OpenSesame` never sends a `COLLECT`.** A2H's `COLLECT` gathers structured
//! input from a human over SMS, email or voice. There is nothing this product
//! could legitimately ask for that way: a credential typed into an SMS reply is
//! a credential in a carrier's logs, and everything else the run needs is a
//! decision, not data. The intent is modelled in [`crate::IntentType`] because
//! the wire has it; no code path produces one.
//!
//! **An A2H response may only narrow authority.** See
//! [`ResponseAuthority`] — it is the security position of this module, and it
//! is not a policy that could be relaxed by raising an assurance level.

use chrono::{DateTime, Utc};
use opensesame_agent_events::{AgentEvent, AgentPhase};
use opensesame_session_observe::UntrustedText;

use crate::envelope::{
    A2hMessage, AssuranceConfig, AssuranceLevel, CallbackConfig, ChannelBinding, Decision,
    IntentType, RenderContent, A2H_VERSION, MAX_BODY_CHARS, MAX_TITLE_CHARS,
};

/// What an A2H reply is allowed to settle.
///
/// A2H reaches a person on a channel that, by design, carries no vault key: an
/// SMS, a push, a phone call. Two consequences follow from the rest of the
/// system rather than from a policy choice, which is why this cannot be widened
/// by asking for a stronger factor:
///
/// - **Taking control is unreachable.** The observation log is sealed to the
///   owner's viewer key (ADR 0078 §9), so driving the page requires a client
///   that holds it. An SMS reply cannot decrypt a frame, let alone issue one.
/// - **Resuming autonomy is unreachable.** ADR 0078 §6 requires the run's
///   preconditions to be re-asserted against the page before the agent drives
///   again, and a reply from a phone asserts nothing about a DOM.
///
/// So A2H can tell you what happened and let you stop it. It cannot let you
/// start anything. A `HIGH` assurance level buys a better-authenticated *stop*,
/// never a wider one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseAuthority {
    /// Acknowledge; the run keeps waiting for a real attach.
    Acknowledge,
    /// Abandon the run. Recoverable — a rotation policy reschedules — which is
    /// why this is the one destructive thing the channel may do.
    Cancel,
}

/// Why a decision could not be applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AuthorityError {
    #[error("an A2H reply may never grant control or resume autonomy")]
    WouldWiden,
    #[error("the intent this answers did not ask for a decision")]
    NotADecision,
}

/// What an `APPROVE` on this intent settles.
///
/// # Errors
///
/// [`AuthorityError::NotADecision`] for an intent that asked nothing —
/// approving an `INFORM` is meaningless, and silently treating it as consent to
/// something is how a notification becomes an authorization.
pub fn authority_for(
    intent: IntentType,
    decision: Decision,
) -> Result<ResponseAuthority, AuthorityError> {
    match (intent, decision) {
        // The only decision this product asks for over A2H: stop.
        (IntentType::Authorize, Decision::Approve) => Ok(ResponseAuthority::Cancel),
        (IntentType::Authorize | IntentType::Escalate, Decision::Decline) => {
            Ok(ResponseAuthority::Acknowledge)
        }
        // "I'm coming" — the run keeps waiting; the actual attach happens in a
        // client that holds the viewer key.
        (IntentType::Escalate, Decision::Approve) => Ok(ResponseAuthority::Acknowledge),
        _ => Err(AuthorityError::NotADecision),
    }
}

/// What a phase reaches a person *as*.
///
/// Total, and deliberately so. An earlier draft returned `None` for the phases
/// that should not wake anybody — a notifier firing on every state change is
/// one people mute, and a muted notifier is the silent failure ADR 0052 §11 is
/// about. But "which events are loud enough to send" is already a property of
/// the subscription: ADR 0080 §2 gives every hook a `severity_min`, and the
/// agent family maps its quiet phases to `Info` and its stuck ones to `Error`.
///
/// Two answers to one question is two answers that can disagree, and the one a
/// reader finds first would be wrong half the time. So this answers only "as
/// what", the subscription answers "whether", and an A2H hook defaults its
/// floor to `error` so registering one still does not sign a person up for a
/// text every time an agent takes a page.
#[must_use]
pub const fn intent_for(phase: AgentPhase) -> IntentType {
    match phase {
        // "The agent cannot continue; a human must take over" is what ESCALATE
        // is for.
        AgentPhase::Blocked | AgentPhase::AwaitingHuman => IntentType::Escalate,
        AgentPhase::Completed | AgentPhase::Failed => IntentType::Result,
        // A state change somebody deliberately subscribed to. It asks nothing,
        // which is exactly INFORM.
        AgentPhase::Started
        | AgentPhase::ControlGranted
        | AgentPhase::ControlReleased
        | AgentPhase::Resumed => IntentType::Inform,
    }
}

/// Assurance for an intent.
///
/// An escalation asks somebody to come and look, which needs no proof of
/// identity — the looking itself is gated by the viewer key. Cancelling a run
/// is the one destructive act the channel permits, so it asks for a real
/// factor.
#[must_use]
pub fn assurance_for(intent: IntentType) -> Option<AssuranceConfig> {
    match intent {
        IntentType::Authorize => Some(AssuranceConfig {
            level: AssuranceLevel::Medium,
            required_factors: vec!["passkey.webauthn.v1".into(), "otp.sms.v1".into()],
        }),
        _ => None,
    }
}

/// Everything the caller supplies that is not derivable from the event.
#[derive(Clone, Debug)]
pub struct IntentContext<'a> {
    /// Our DID, as the A2H `agent_id`.
    pub agent_id: &'a str,
    /// Where the human is reached, if the caller pins one. Omitted lets the
    /// gateway choose and fail over, which is the whole point of using one.
    pub channel: Option<ChannelBinding>,
    /// Where the gateway posts the reply.
    pub callback: Option<CallbackConfig>,
    /// Deep link into the attach ceremony, shown to the human.
    pub attach_url: Option<&'a str>,
    /// This gateway's TTL ceiling, from `/.well-known/a2h`.
    pub max_ttl_sec: Option<i64>,
}

/// Build the A2H message for an agent event.
///
/// The TTL is the run's own remaining window, never an independently chosen
/// number: a notification that outlives the thing it is about asks somebody to
/// act on a run that has already parked, and one that dies first leaves them
/// holding a link that no longer works.
#[must_use]
pub fn message_for(
    event: &AgentEvent,
    context: &IntentContext<'_>,
    now: DateTime<Utc>,
    interaction_id: &str,
    message_id: &str,
) -> A2hMessage {
    let intent_type = intent_for(event.phase);
    let ttl_sec = ttl_for(event, context.max_ttl_sec, now);
    A2hMessage {
        a2h_version: A2H_VERSION.to_string(),
        interaction_id: interaction_id.to_string(),
        intent_type,
        message_id: message_id.to_string(),
        agent_id: context.agent_id.to_string(),
        principal_id: event.run.owner_principal_id.clone(),
        channel: context.channel.clone(),
        render: render_for(event, context.attach_url),
        ttl_sec,
        assurance: assurance_for(intent_type),
        callback: context.callback.clone(),
        created_at: now.to_rfc3339(),
        explanation_bundle: Some(serde_json::json!({
            "why": format!(
                "`OpenSesame` is rotating a saved password at {}.",
                event.run.origin
            ),
        })),
    }
}

/// The interaction's lifetime, from the run's deadline.
fn ttl_for(event: &AgentEvent, gateway_max: Option<i64>, now: DateTime<Utc>) -> i64 {
    let requested = event
        .seconds_to_respond(now)
        .unwrap_or(crate::envelope::MIN_TTL_SEC);
    let ceiling = gateway_max
        .unwrap_or(crate::envelope::MAX_TTL_SEC)
        .min(crate::envelope::MAX_TTL_SEC);
    requested.clamp(
        crate::envelope::MIN_TTL_SEC,
        ceiling.max(crate::envelope::MIN_TTL_SEC),
    )
}

/// What the human reads.
///
/// Built from structured fields. The operator hint is the one piece that can
/// carry a third party's text — a rotation outcome quotes what the run was
/// doing — so it goes through [`UntrustedText`] first. An SMS gives a reader no
/// chrome to notice a bidirectional override in, and this text arrives with our
/// name on it.
fn render_for(event: &AgentEvent, attach_url: Option<&str>) -> RenderContent {
    let origin = UntrustedText::capture(&event.run.origin);
    let title = match event.phase {
        AgentPhase::Blocked | AgentPhase::AwaitingHuman => "Password change needs you",
        AgentPhase::Completed => "Password changed",
        AgentPhase::Failed => "Password change failed",
        _ => "`OpenSesame`",
    };
    let mut body = match event.phase {
        AgentPhase::Blocked | AgentPhase::AwaitingHuman => format!(
            "`OpenSesame` stopped part-way through changing your password at {}. \
             Your old password still works. Open `OpenSesame` to see what happened \
             and finish it.",
            origin.as_untrusted_str()
        ),
        AgentPhase::Completed => format!(
            "`OpenSesame` finished changing your password at {}. The new one is saved.",
            origin.as_untrusted_str()
        ),
        AgentPhase::Failed => format!(
            "`OpenSesame` could not change your password at {}. Your old password \
             still works and nothing was changed.",
            origin.as_untrusted_str()
        ),
        _ => format!(
            "`OpenSesame` has an update about {}.",
            origin.as_untrusted_str()
        ),
    };
    if let Some(detail) = &event.detail {
        let hint = UntrustedText::capture(detail);
        body.push_str("\n\nDetail: ");
        body.push_str(hint.as_untrusted_str());
    }
    if let Some(url) = attach_url {
        body.push_str("\n\n");
        body.push_str(url);
    }
    RenderContent {
        title: Some(truncate(title, MAX_TITLE_CHARS)),
        body: truncate(&body, MAX_BODY_CHARS),
        footer: None,
    }
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
