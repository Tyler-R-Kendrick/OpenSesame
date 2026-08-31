//! Frozen `agent.*` hook event names and their value-blind payloads (ADR 0078).
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
//! Two structural properties are worth naming:
//!
//! - **A request for a human carries its deadline, or it does not exist.**
//!   [`AgentEvent::waiting`] requires a `responds_by`; [`AgentEvent::notice`]
//!   refuses one. A blocked run is holding a live authenticated session open
//!   while it waits, so "respond by" is not decoration — it is the difference
//!   between asking someone to act and asking them to act on something that
//!   already timed out.
//! - **The payload is built key by key.** Nothing is serialized from a caller's
//!   map, and no key matches the audit redactor's deny pattern (ADR 0046 §14:
//!   `token`, `value`, `secret`, `user_code`, `device_code` are dropped
//!   *before* the allowlist is consulted, so a well-meaning key name can blank
//!   the one field a reviewer needs).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;

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
pub const EVENT_WILDCARD: &str = "agent.*";

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

/// Whether a subscription filter selects `event_type`.
#[must_use]
pub fn filter_matches(filter: &[String], event_type: &str) -> bool {
    filter
        .iter()
        .any(|entry| entry == EVENT_WILDCARD || entry == event_type)
}

/// Whether every entry in a filter is a name this family recognises.
#[must_use]
pub fn filter_is_valid(filter: &[String]) -> bool {
    !filter.is_empty()
        && filter
            .iter()
            .all(|entry| entry == EVENT_WILDCARD || is_agent_event_type(entry))
}

/// The run an event is about. Metadata only — an origin, never an account, and
/// no field able to carry what the run saw.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRun {
    pub run_id: String,
    pub job_id: String,
    pub organization_id: String,
    /// The principal whose credential is being rotated, and the only one
    /// entitled to observe (ADR 0078 §8).
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
    /// # Errors
    ///
    /// [`AgentEventError::MissingDeadline`] when the phase does wait on a
    /// person — an escalation with no deadline is how a notification becomes
    /// something nobody can act on in time.
    pub fn notice(
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
}

fn truncate(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-08-31T00:00:00Z".parse().unwrap()
    }

    fn run() -> AgentRun {
        AgentRun {
            run_id: "run:1".into(),
            job_id: "job:1".into(),
            organization_id: "org:one".into(),
            owner_principal_id: "principal:alice".into(),
            origin: "https://example.com".into(),
            tier: "t4".into(),
            control_state: "agent_driving".into(),
        }
    }

    #[test]
    fn event_names_are_frozen() {
        assert_eq!(
            AGENT_EVENT_TYPES,
            [
                "agent.run.started",
                "agent.run.blocked",
                "agent.control.awaiting_human",
                "agent.control.granted",
                "agent.control.released",
                "agent.run.resumed",
                "agent.run.completed",
                "agent.run.failed",
            ]
        );
        assert_eq!(EVENT_WILDCARD, "agent.*");
    }

    #[test]
    fn every_phase_has_a_registered_event_name() {
        for phase in [
            AgentPhase::Started,
            AgentPhase::Blocked,
            AgentPhase::AwaitingHuman,
            AgentPhase::ControlGranted,
            AgentPhase::ControlReleased,
            AgentPhase::Resumed,
            AgentPhase::Completed,
            AgentPhase::Failed,
        ] {
            assert!(
                is_agent_event_type(phase.event_type()),
                "{phase:?} publishes under an unregistered name"
            );
        }
    }

    #[test]
    fn an_escalation_cannot_be_built_without_a_deadline() {
        // The whole point: a blocked run is holding a live authenticated
        // session open while it waits, so there is no such thing as asking a
        // person to act on it with no clock.
        assert_eq!(
            AgentEvent::notice(run(), AgentPhase::Blocked, now(), None),
            Err(AgentEventError::MissingDeadline)
        );
        assert_eq!(
            AgentEvent::notice(run(), AgentPhase::AwaitingHuman, now(), None),
            Err(AgentEventError::MissingDeadline)
        );
    }

    #[test]
    fn a_notice_cannot_carry_a_deadline_it_does_not_mean() {
        assert_eq!(
            AgentEvent::waiting(run(), AgentPhase::Completed, now(), now(), None),
            Err(AgentEventError::UnexpectedDeadline)
        );
    }

    #[test]
    fn time_to_respond_floors_at_zero() {
        let deadline = now() + chrono::Duration::seconds(300);
        let event = AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, None).unwrap();
        assert_eq!(event.seconds_to_respond(now()), Some(300));
        assert_eq!(
            event.seconds_to_respond(now() + chrono::Duration::seconds(900)),
            Some(0)
        );
        let notice = AgentEvent::notice(run(), AgentPhase::Completed, now(), None).unwrap();
        assert_eq!(notice.seconds_to_respond(now()), None);
    }

    #[test]
    fn a_filter_that_names_nothing_matches_nothing() {
        assert!(!filter_is_valid(&[]));
        assert!(!filter_matches(&[], EVENT_RUN_BLOCKED));
        assert!(filter_is_valid(&[EVENT_WILDCARD.into()]));
        assert!(filter_matches(&[EVENT_WILDCARD.into()], EVENT_RUN_BLOCKED));
        assert!(!filter_is_valid(&["agent.run.exploded".into()]));
        assert!(!filter_is_valid(&["lifecycle.renewal.due".into()]));
    }

    #[test]
    fn payload_is_value_blind_and_survives_the_audit_redactor() {
        let deadline = now() + chrono::Duration::seconds(300);
        let event = AgentEvent::waiting(
            run(),
            AgentPhase::Blocked,
            now(),
            deadline,
            Some("step-up challenge on the settings page"),
        )
        .unwrap();
        let payload = event.payload();
        let object = payload.as_object().unwrap();
        assert_eq!(object["event_type"], json!(EVENT_RUN_BLOCKED));
        assert_eq!(object["needs_human"], json!(true));
        assert_eq!(object["observation_included"], json!(false));
        assert_eq!(object["responds_by"], json!(deadline.to_rfc3339()));
        // ADR 0046 §14: `packages/audit`'s deny pass runs before its allowlist
        // and matches these as unanchored substrings, so any key containing one
        // is dropped even after being allowlisted — leaving a reviewer with a
        // blank where the fact was. No carve-out here: a key that needs an
        // exemption is a key that would arrive blank in an audit row.
        for key in object.keys() {
            for forbidden in [
                "value",
                "token",
                "secret",
                "password",
                "authorization",
                "cookie",
                "user_code",
                "device_code",
                "refresh",
                "bearer",
            ] {
                assert!(
                    !key.contains(forbidden),
                    "payload key `{key}` would be dropped by the audit redactor"
                );
            }
        }
    }

    #[test]
    fn a_notice_omits_the_deadline_rather_than_nulling_it() {
        let event = AgentEvent::notice(run(), AgentPhase::Completed, now(), None).unwrap();
        let payload = event.payload();
        let object = payload.as_object().unwrap();
        assert!(!object.contains_key("responds_by"));
        assert_eq!(object["needs_human"], json!(false));
    }

    #[test]
    fn a_payload_round_trips_back_into_the_fact_it_described() {
        let deadline = now() + chrono::Duration::seconds(300);
        for original in [
            AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, Some("stuck"))
                .unwrap(),
            AgentEvent::waiting(run(), AgentPhase::AwaitingHuman, now(), deadline, None).unwrap(),
            AgentEvent::notice(run(), AgentPhase::Completed, now(), Some("done")).unwrap(),
            AgentEvent::notice(run(), AgentPhase::Failed, now(), None).unwrap(),
            AgentEvent::notice(run(), AgentPhase::Started, now(), None).unwrap(),
        ] {
            let rebuilt = AgentEvent::from_payload(&original.payload());
            assert_eq!(rebuilt.as_ref(), Some(&original), "{original:?}");
        }
    }

    #[test]
    fn a_half_read_payload_is_refused_rather_than_repaired() {
        let deadline = now() + chrono::Duration::seconds(300);
        let event = AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, None).unwrap();

        // A missing field is not defaulted: a notification built from one would
        // name the wrong origin or the wrong person.
        for key in [
            "phase",
            "run_id",
            "origin",
            "owner_principal_id",
            "occurred_at",
        ] {
            let mut payload = event.payload();
            payload.as_object_mut().unwrap().remove(key);
            assert!(
                AgentEvent::from_payload(&payload).is_none(),
                "payload without {key} was accepted"
            );
        }

        // And the construction rule holds in both directions.
        let mut deadlineless = event.payload();
        deadlineless.as_object_mut().unwrap().remove("responds_by");
        assert!(AgentEvent::from_payload(&deadlineless).is_none());

        let mut notice = AgentEvent::notice(run(), AgentPhase::Completed, now(), None)
            .unwrap()
            .payload();
        notice
            .as_object_mut()
            .unwrap()
            .insert("responds_by".into(), json!(deadline.to_rfc3339()));
        assert!(AgentEvent::from_payload(&notice).is_none());
    }

    #[test]
    fn a_hint_is_truncated_rather_than_carried_whole() {
        let long = "x".repeat(MAX_DETAIL_CHARS + 200);
        let event = AgentEvent::notice(run(), AgentPhase::Failed, now(), Some(&long)).unwrap();
        assert_eq!(
            event.detail.as_deref().unwrap().chars().count(),
            MAX_DETAIL_CHARS
        );
    }
}
