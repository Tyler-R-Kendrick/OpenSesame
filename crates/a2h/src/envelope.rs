use serde::{Deserialize, Serialize};

/// A2H protocol version this implementation speaks.
pub const A2H_VERSION: &str = "1.0";

/// The five intent types, plus the two reply types, from the A2H v1.0
/// specification. Serialized exactly as the wire spells them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IntentType {
    /// One-way notification.
    Inform,
    /// Gather structured input. `OpenSesame` never sends one — see
    /// [`crate::intent`]'s module docs.
    Collect,
    /// Request approval with authentication.
    Authorize,
    /// Hand off to a human.
    Escalate,
    /// Report task completion or outcome.
    Result,
    /// The human's reply.
    Response,
    Error,
}

/// Where a message is delivered. `principal_id` is *who*; this is *where*.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelBinding {
    /// `sms`, `email`, `whatsapp`, `push`, `voice`, `wallet`, `chat`.
    #[serde(rename = "type")]
    pub channel_type: String,
    /// Routable address under a real URI scheme (`tel:`, `mailto:`, …).
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub fallback: Vec<FallbackChannel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FallbackChannel {
    #[serde(rename = "type")]
    pub channel_type: String,
    pub address: String,
}

/// What the human is shown.
///
/// Built from structured fields only. Any operator hint that reaches `body`
/// passes through `UntrustedText` first: the hint can carry a third party's
/// text, and this string is rendered in an SMS, a push notification and a voice
/// prompt — three places with no room for a reader to notice something is off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

/// Longest `body` the spec accepts.
pub const MAX_BODY_CHARS: usize = 4_096;
/// Longest `title` the spec accepts.
pub const MAX_TITLE_CHARS: usize = 256;

/// Assurance the gateway must reach before it reports a decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum AssuranceLevel {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssuranceConfig {
    pub level: AssuranceLevel,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub required_factors: Vec<String>,
}

/// Where the gateway posts the human's reply, and the secret it signs with.
///
/// `secret` is a `whsec_` value — the same shape the lifecycle feed's Standard
/// Webhooks path already mints — so one secret convention covers both
/// directions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallbackConfig {
    pub url: String,
    pub secret: String,
}

/// One A2H message on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct A2hMessage {
    pub a2h_version: String,
    pub interaction_id: String,
    #[serde(rename = "type")]
    pub intent_type: IntentType,
    pub message_id: String,
    /// The software acting on the human's behalf. A DID, per the spec's
    /// examples.
    pub agent_id: String,
    /// Stable, non-routable identifier for the human. Never an address.
    pub principal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<ChannelBinding>,
    pub render: RenderContent,
    /// Seconds the interaction stays open. Derived from the run's own deadline,
    /// never chosen independently — see [`crate::intent`].
    pub ttl_sec: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assurance: Option<AssuranceConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback: Option<CallbackConfig>,
    pub created_at: String,
    /// Non-secret context for why this is being asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation_bundle: Option<serde_json::Value>,
}

/// The spec's TTL bounds. A gateway rejects anything outside them, so clamping
/// here means a long-parked run still produces a deliverable message.
pub const MIN_TTL_SEC: i64 = 30;
pub const MAX_TTL_SEC: i64 = 86_400;

/// Where an interaction is, per the spec's state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InteractionState {
    Pending,
    Sent,
    WaitingInput,
    Answered,
    Expired,
    Cancelled,
    Failed,
}

/// The human's decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Decision {
    Approve,
    Decline,
}

/// Factor-specific proof that a human authenticated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    /// `passkey.webauthn.v1`, `otp.sms.v1`, `push.v1`, `voice.ivr.v1`, …
    pub factor: String,
    #[serde(default)]
    pub proof: serde_json::Value,
}

/// The gateway's reply, delivered to our callback.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct A2hResponse {
    #[serde(rename = "type")]
    pub message_type: IntentType,
    pub interaction_id: String,
    /// The `message_id` of the intent this answers.
    pub responds_to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<Decision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
    /// Detached JWS by the gateway over the canonical message. Verified when a
    /// `jwks_uri` is configured; the callback HMAC is the layer that is always
    /// checked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Protocol-defined error codes.
///
/// [`ErrorCode::QuietHours`] is the one with teeth here: it means the message
/// was **not delivered**, and treating it as delivered is how a blocked run's
/// deadline passes with nobody told (see [`crate::DeliveryOutcome`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    #[serde(rename = "ERR.EXPIRED")]
    Expired,
    #[serde(rename = "ERR.INVALID_REQUEST")]
    InvalidRequest,
    #[serde(rename = "ERR.INVALID_PRINCIPAL")]
    InvalidPrincipal,
    #[serde(rename = "ERR.CHANNEL_UNAVAILABLE")]
    ChannelUnavailable,
    #[serde(rename = "ERR.CONFLICT")]
    Conflict,
    #[serde(rename = "ERR.REPLAY_REJECTED")]
    ReplayRejected,
    #[serde(rename = "ERR.RATE_LIMITED")]
    RateLimited,
    #[serde(rename = "ERR.DELIVERY_FAILED")]
    DeliveryFailed,
    #[serde(rename = "ERR.QUIET_HOURS")]
    QuietHours,
}

/// The gateway's `/.well-known/a2h` document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayCapabilities {
    pub a2h_supported: Vec<String>,
    pub channels: Vec<String>,
    pub factors: Vec<String>,
    #[serde(default)]
    pub max_ttl_sec: Option<i64>,
    #[serde(default)]
    pub jwks_uri: Option<String>,
}

impl GatewayCapabilities {
    /// Whether this gateway speaks a version we can talk to.
    #[must_use]
    pub fn supports_our_version(&self) -> bool {
        self.a2h_supported.iter().any(|v| v == A2H_VERSION)
    }

    /// The TTL to send, respecting both the spec bounds and this gateway's own
    /// ceiling.
    #[must_use]
    pub fn clamp_ttl(&self, requested: i64) -> i64 {
        let ceiling = self.max_ttl_sec.unwrap_or(MAX_TTL_SEC).min(MAX_TTL_SEC);
        requested.clamp(MIN_TTL_SEC, ceiling.max(MIN_TTL_SEC))
    }
}
