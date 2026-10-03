//! Frozen `agent.*` hook event names and their value-blind payloads (ADR 0081).
//!
//! When an agent driving somebody's account gets stuck, somebody has to hear
//! about it. This crate is the vocabulary for that, and it is deliberately a
//! *feed* rather than a notifier: the platform publishes a fact, and every
//! delivery — a webhook, an A2H intent to a phone, `OpenSesame`'s own UI — is a
//! subscriber to the same fact.
//!
//! That is ADR 0074's rule applied one subsystem over. A blocked run must not
//! be announced by a private call from the runner to whichever channel someone
//! wired up, because the path nobody else uses is the path that rots. Our own
//! notification is a subscriber, so a break in the feed breaks us first.
//!
//! `agent.*` is the **third** family on ADR 0080's one security-event feed,
//! beside `lifecycle.*` and `breach.*`. It gets there the way that ADR says a
//! new detector must: by implementing a conversion into [`SecurityNotice`] and
//! nothing else. There is no `agent_hooks` module, no second subscription
//! table, and no private fan-out — the subscription model, the delivery
//! ledger, the built-in notifier, the built-in alerter, Alertmanager,
//! `PagerDuty` and RFC 5424 syslog all come for free, and none of them learns
//! that agent runs exist.
//!
//! Two structural properties are worth naming:
//!
//! - **A request for a human carries its deadline, or it does not exist.**
//!   [`AgentEvent::waiting`] requires a `responds_by`;
//!   [`AgentEvent::reporting`] refuses one. A blocked run is holding a live
//!   authenticated session open while it waits, so "respond by" is not
//!   decoration — it is the difference between asking someone to act and
//!   asking them to act on something that already timed out.
//! - **The payload is built key by key.** Nothing is serialized from a caller's
//!   map, and no key matches the audit redactor's deny pattern (ADR 0046 §14:
//!   `token`, `value`, `secret`, `user_code`, `device_code` are dropped
//!   *before* the allowlist is consulted, so a well-meaning key name can blank
//!   the one field a reviewer needs).
//!
//! The crate also carries the `surrogate.*` family (ADR 0150 §5): a surrogate
//! is issued to an agent run, and a surrogate refused anywhere but its one
//! declared site is that run's tripwire. See [`surrogate`] for its vocabulary
//! and the fences its free text passes before it is published.

use chrono::{DateTime, Utc};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;

pub mod surrogate;
pub use surrogate::{
    surrogate_refusal_notice, SurrogateEvent, SurrogateFence, SurrogateNoticeError,
    SurrogateRefusalReport, SURROGATE_EVENT_TYPES, SURROGATE_EVENT_WILDCARD,
    SURROGATE_SUBJECT_KINDS,
};

/// A sandboxed run started against a relying party.
pub const EVENT_RUN_STARTED: &str = "agent.run.started";
/// The run parked and cannot continue without a person. This is the event a
/// notifier escalates on.
pub const EVENT_RUN_BLOCKED: &str = "agent.run.blocked";
/// The agent stopped and the control lease is unclaimed — someone asked to take
/// the page, or the agent reached a point it will not pass alone.
pub const EVENT_AWAITING_HUMAN: &str = "agent.control.awaiting_human";
/// A person took the page.
pub const EVENT_CONTROL_GRANTED: &str = "agent.control.granted";
/// A person handed the page back. Autonomy has not resumed yet.
pub const EVENT_CONTROL_RELEASED: &str = "agent.control.released";
/// Autonomy resumed, after the run's preconditions were re-asserted.
pub const EVENT_RUN_RESUMED: &str = "agent.run.resumed";
/// The run finished its work.
pub const EVENT_RUN_COMPLETED: &str = "agent.run.completed";
/// The run ended without finishing, and not because it is waiting.
pub const EVENT_RUN_FAILED: &str = "agent.run.failed";

/// Every event type a hook may subscribe to in this family.
pub const AGENT_EVENT_TYPES: &[&str] = &[
    EVENT_RUN_STARTED,
    EVENT_RUN_BLOCKED,
    EVENT_AWAITING_HUMAN,
    EVENT_CONTROL_GRANTED,
    EVENT_CONTROL_RELEASED,
    EVENT_RUN_RESUMED,
    EVENT_RUN_COMPLETED,
    EVENT_RUN_FAILED,
];

/// Subscription wildcard: every agent event.
///
/// Matched by `opensesame_security_events::filter`, which reads `<family>.*`
/// for any family. This crate deliberately ships no filter of its own: a
/// second implementation is how one of them ends up disagreeing about what
/// `*` means (ADR 0080 §1).
pub const EVENT_WILDCARD: &str = "agent.*";

/// The subject kind an agent run reports under.
///
/// The same kind the expiry ladder uses for a web-login rotation policy, and
/// the same subject id — the relying party's origin. That is deliberate: an
/// operator who narrows a subscription to `web_login` gets the deadline and
/// the run that acts on it, rather than two unrelated-looking feeds about one
/// thing. The alert identity still separates them, because
/// `SecurityNotice::alert_key` is scoped by family.
pub const AGENT_SUBJECT_KIND: &str = "web_login";

/// Longest value-blind hint carried into a payload.
pub const MAX_DETAIL_CHARS: usize = 160;

/// Where a run is, as a phase a subscriber can switch on without string
/// matching an event name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPhase {
    Started,
    Blocked,
    AwaitingHuman,
    ControlGranted,
    ControlReleased,
    Resumed,
    Completed,
    Failed,
}

impl AgentPhase {
    /// The frozen event name this phase publishes under.
    #[must_use]
    pub const fn event_type(self) -> &'static str {
        match self {
            Self::Started => EVENT_RUN_STARTED,
            Self::Blocked => EVENT_RUN_BLOCKED,
            Self::AwaitingHuman => EVENT_AWAITING_HUMAN,
            Self::ControlGranted => EVENT_CONTROL_GRANTED,
            Self::ControlReleased => EVENT_CONTROL_RELEASED,
            Self::Resumed => EVENT_RUN_RESUMED,
            Self::Completed => EVENT_RUN_COMPLETED,
            Self::Failed => EVENT_RUN_FAILED,
        }
    }

    /// Whether this phase is the run waiting on a person.
    ///
    /// The distinction a notifier routes on: a waiting phase is an escalation
    /// with a deadline, everything else is a notice. Deriving it here rather
    /// than in each notifier keeps two channels from disagreeing about whether
    /// the user has to do something.
    #[must_use]
    pub const fn needs_human(self) -> bool {
        matches!(self, Self::Blocked | Self::AwaitingHuman)
    }

    /// How loud this phase is on the security feed.
    ///
    /// Calibrated against ADR 0080 §2's rule that the platform's own responder
    /// doing its job is not a page: a run starting, a person arriving, and a
    /// run finishing are all `Info`. The two rungs that stall a rotation
    /// somebody is relying on are `Error`, and the two where the run is parked
    /// with a person nominally in the loop are `Warning`.
    ///
    /// `Blocked` is deliberately as loud as `Failed`. A blocked run is not
    /// waiting politely — it is holding a live authenticated session open at a
    /// third party until its deadline passes, so "nobody answered" costs more
    /// than an ordinary failure does.
    #[must_use]
    pub const fn severity(self) -> Severity {
        match self {
            Self::Started | Self::ControlGranted | Self::Resumed | Self::Completed => {
                Severity::Info
            }
            Self::AwaitingHuman | Self::ControlReleased => Severity::Warning,
            Self::Blocked | Self::Failed => Severity::Error,
        }
    }

    /// Whether this phase settles the run's condition or raises one.
    ///
    /// The alert key is per-subject and per-family, so these compose into one
    /// incident per origin that opens when the run needs something and closes
    /// when it stops needing it:
    ///
    /// ```text
    /// started(firing) → blocked(firing) → control.granted(RESOLVED)
    ///                                   → control.released(firing)
    ///                                   → resumed(RESOLVED)
    /// ```
    ///
    /// `ControlGranted` resolves because a page exists to fetch a human, and a
    /// human arriving is what it was fetching. `Failed` does **not** resolve:
    /// the credential did not rotate, and that stays true until a later run
    /// completes.
    #[must_use]
    pub const fn notice_state(self) -> NoticeState {
        match self {
            Self::ControlGranted | Self::Resumed | Self::Completed => NoticeState::Resolved,
            Self::Started
            | Self::Blocked
            | Self::AwaitingHuman
            | Self::ControlReleased
            | Self::Failed => NoticeState::Firing,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Blocked => "blocked",
            Self::AwaitingHuman => "awaiting_human",
            Self::ControlGranted => "control_granted",
            Self::ControlReleased => "control_released",
            Self::Resumed => "resumed",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[must_use]
pub fn is_agent_event_type(event_type: &str) -> bool {
    AGENT_EVENT_TYPES.contains(&event_type)
}

/// The run an event is about. Metadata only — an origin, never an account, and
/// no field able to carry what the run saw.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRun {
    pub run_id: String,
    pub job_id: String,
    pub organization_id: String,
    /// The principal whose credential is being rotated, and the only one
    /// entitled to observe (ADR 0081 §8).
    pub owner_principal_id: String,
    /// The relying party's origin.
    pub origin: String,
    /// `t3` (deterministic) or `t4` (agentic).
    pub tier: String,
    /// `crates/session-observe`'s `ControlState`, as its wire name.
    pub control_state: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentEventError {
    #[error("a phase that waits on a person must carry a deadline")]
    MissingDeadline,
    #[error("a phase that does not wait on a person must not carry a deadline")]
    UnexpectedDeadline,
}

/// One agent fact, ready to be recorded and fanned out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentEvent {
    pub event_type: String,
    pub phase: AgentPhase,
    pub run: AgentRun,
    pub occurred_at: DateTime<Utc>,
    /// When the run stops waiting and parks for good. `Some` exactly when
    /// [`AgentPhase::needs_human`] is true.
    pub responds_by: Option<DateTime<Utc>>,
    /// Value-blind operator hint — why it stopped, never what it saw.
    pub detail: Option<String>,
}

impl AgentEvent {
    /// A phase that waits on a person, with the deadline it waits until.
    ///
    /// # Errors
    ///
    /// [`AgentEventError::UnexpectedDeadline`] when the phase does not wait. A
    /// deadline on a notice would be read as "act by then" for something that
    /// needs no action.
    pub fn waiting(
        run: AgentRun,
        phase: AgentPhase,
        occurred_at: DateTime<Utc>,
        responds_by: DateTime<Utc>,
        detail: Option<&str>,
    ) -> Result<Self, AgentEventError> {
        if !phase.needs_human() {
            return Err(AgentEventError::UnexpectedDeadline);
        }
        Ok(Self {
            event_type: phase.event_type().to_string(),
            phase,
            run,
            occurred_at,
            responds_by: Some(responds_by),
            detail: detail.map(|raw| truncate(raw, MAX_DETAIL_CHARS)),
        })
    }

    /// A phase that reports rather than asks.
    ///
    /// Named for what it does rather than what it produces: [`Self::notice`]
    /// is the conversion onto ADR 0080's feed, and every detector family
    /// spells that one the same way.
    ///
    /// # Errors
    ///
    /// [`AgentEventError::MissingDeadline`] when the phase does wait on a
    /// person — an escalation with no deadline is how a notification becomes
    /// something nobody can act on in time.
    pub fn reporting(
        run: AgentRun,
        phase: AgentPhase,
        occurred_at: DateTime<Utc>,
        detail: Option<&str>,
    ) -> Result<Self, AgentEventError> {
        if phase.needs_human() {
            return Err(AgentEventError::MissingDeadline);
        }
        Ok(Self {
            event_type: phase.event_type().to_string(),
            phase,
            run,
            occurred_at,
            responds_by: None,
            detail: detail.map(|raw| truncate(raw, MAX_DETAIL_CHARS)),
        })
    }

    /// Seconds a person has left to respond, floored at zero.
    ///
    /// `None` when nothing is waiting.
    #[must_use]
    pub fn seconds_to_respond(&self, now: DateTime<Utc>) -> Option<i64> {
        self.responds_by
            .map(|deadline| (deadline - now).num_seconds().max(0))
    }

    /// Reconstruct an event from the payload a subscriber received.
    ///
    /// The delivery ledger is the durable queue (ADR 0039's saga shape), so a
    /// notifier that survives a restart works from the persisted payload rather
    /// than from the in-memory event. That makes the payload a two-way contract:
    /// whatever a subscriber is given must be enough to rebuild the fact, and
    /// the round-trip test is what keeps a field from being dropped from the
    /// wire without anyone noticing.
    ///
    /// Returns `None` when a required field is absent or unparseable, rather
    /// than filling in a default — a notification built from a half-read event
    /// would name the wrong origin or the wrong person.
    #[must_use]
    pub fn from_payload(payload: &Value) -> Option<Self> {
        let body = payload.as_object()?;
        let text = |key: &str| body.get(key)?.as_str().map(str::to_string);
        let phase = match body.get("phase")?.as_str()? {
            "started" => AgentPhase::Started,
            "blocked" => AgentPhase::Blocked,
            "awaiting_human" => AgentPhase::AwaitingHuman,
            "control_granted" => AgentPhase::ControlGranted,
            "control_released" => AgentPhase::ControlReleased,
            "resumed" => AgentPhase::Resumed,
            "completed" => AgentPhase::Completed,
            "failed" => AgentPhase::Failed,
            _ => return None,
        };
        let occurred_at = DateTime::parse_from_rfc3339(body.get("occurred_at")?.as_str()?)
            .ok()?
            .with_timezone(&Utc);
        let responds_by = match body.get("responds_by") {
            Some(value) => Some(
                DateTime::parse_from_rfc3339(value.as_str()?)
                    .ok()?
                    .with_timezone(&Utc),
            ),
            None => None,
        };
        // The construction rule holds on the way back in: a waiting phase
        // without a deadline, or a notice carrying one, is a payload we refuse
        // rather than repair.
        if phase.needs_human() != responds_by.is_some() {
            return None;
        }
        let run = AgentRun {
            run_id: text("run_id")?,
            job_id: text("job_id")?,
            organization_id: text("organization_id")?,
            owner_principal_id: text("owner_principal_id")?,
            origin: text("origin")?,
            tier: text("tier")?,
            control_state: text("control_state")?,
        };
        Some(Self {
            event_type: phase.event_type().to_string(),
            phase,
            run,
            occurred_at,
            responds_by,
            detail: text("detail"),
        })
    }

    /// The value-blind payload a subscriber receives.
    #[must_use]
    pub fn payload(&self) -> Value {
        let mut body = Map::new();
        body.insert("event_type".into(), json!(self.event_type));
        body.insert("phase".into(), json!(self.phase.as_str()));
        body.insert("needs_human".into(), json!(self.phase.needs_human()));
        body.insert("run_id".into(), json!(self.run.run_id));
        body.insert("job_id".into(), json!(self.run.job_id));
        body.insert("organization_id".into(), json!(self.run.organization_id));
        body.insert(
            "owner_principal_id".into(),
            json!(self.run.owner_principal_id),
        );
        body.insert("origin".into(), json!(self.run.origin));
        body.insert("tier".into(), json!(self.run.tier));
        body.insert("control_state".into(), json!(self.run.control_state));
        body.insert("occurred_at".into(), json!(self.occurred_at.to_rfc3339()));
        if let Some(responds_by) = self.responds_by {
            body.insert("responds_by".into(), json!(responds_by.to_rfc3339()));
        }
        if let Some(detail) = &self.detail {
            body.insert("detail".into(), json!(truncate(detail, MAX_DETAIL_CHARS)));
        }
        // Explicit non-disclosure: a subscriber never has to infer that this
        // feed carries no page content, no frame and no rationale — only that a
        // run is in a state.
        //
        // The lifecycle feed spells this `secrets_returned`, and this one
        // deliberately does not. `packages/audit`'s DENY_KEY is an *unanchored*
        // substring match (`/value|token|secret|.../i`), so a key containing
        // "secret" is dropped before the allowlist is consulted — an assertion
        // of non-disclosure that vanishes exactly when it is written into an
        // audit row. `observation_included` carries the claim that is
        // load-bearing for this feed and survives both paths.
        body.insert("observation_included".into(), json!(false));
        Value::Object(body)
    }

    /// One line a human reads first.
    ///
    /// Built from the origin and the phase, never from what the run saw. The
    /// hint is appended only where it is the actionable part — knowing that a
    /// run completed is enough, knowing *why* one stopped is the whole point.
    #[must_use]
    pub fn summary(&self) -> String {
        let origin = &self.run.origin;
        let head = match self.phase {
            AgentPhase::Started => format!("a password rotation started at {origin}"),
            AgentPhase::Blocked => {
                format!("a password rotation at {origin} is stuck and needs you")
            }
            AgentPhase::AwaitingHuman => {
                format!("a password rotation at {origin} is waiting for someone to take the page")
            }
            AgentPhase::ControlGranted => format!("someone took the page at {origin}"),
            AgentPhase::ControlReleased => {
                format!("the page at {origin} was handed back and the run is parked")
            }
            AgentPhase::Resumed => format!("the password rotation at {origin} resumed"),
            AgentPhase::Completed => format!("the password at {origin} was rotated"),
            AgentPhase::Failed => format!("the password rotation at {origin} did not finish"),
        };
        match (&self.detail, self.phase.severity()) {
            (Some(detail), Severity::Warning | Severity::Error | Severity::Critical) => {
                format!("{head}: {detail}")
            }
            _ => head,
        }
    }

    /// The normalized envelope the notifier, the alerter, and every sink read.
    ///
    /// This method is the crate's entire integration with ADR 0080's feed.
    /// Everything downstream — subscription matching, the delivery ledger,
    /// Alertmanager, `PagerDuty`, syslog — already exists and learns nothing
    /// about agent runs.
    #[must_use]
    pub fn notice(&self) -> SecurityNotice {
        SecurityNotice {
            event_type: self.event_type.clone(),
            severity: self.phase.severity(),
            state: self.phase.notice_state(),
            organization_id: self.run.organization_id.clone(),
            subject_kind: AGENT_SUBJECT_KIND.to_string(),
            // The relying party, which is what a subscriber deduplicates and
            // rate-limits on, and what the expiry ladder already keys a
            // web-login policy by. Never an account.
            subject_id: self.run.origin.clone(),
            label: None,
            occurred_at: self.occurred_at,
            summary: self.summary(),
            detail: self.detail.clone(),
            payload: self.payload(),
        }
    }
}

fn truncate(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests;
