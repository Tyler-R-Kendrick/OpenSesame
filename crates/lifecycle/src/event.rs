//! Frozen hook event names and their value-blind payloads.
//!
//! These strings are the public contract a subscriber writes a filter against.
//! They are frozen in the same sense as the changelog's event names: additive
//! only, never renamed, and pinned by a unit test so a refactor cannot quietly
//! break every registered hook.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::stage::ExpiryStage;
use crate::subject::ExpirySubject;

/// Something is expiring within 30 days.
pub const EVENT_EXPIRY_NOTICE: &str = "lifecycle.expiry.notice";
/// Something is expiring within 7 days.
pub const EVENT_EXPIRY_WARNING: &str = "lifecycle.expiry.warning";
/// Something is expiring within 24 hours.
pub const EVENT_EXPIRY_URGENT: &str = "lifecycle.expiry.urgent";
/// The renewal window opened — reissue now. This is the rung `OpenSesame`'s own
/// rotation and certificate responders act on.
pub const EVENT_RENEWAL_DUE: &str = "lifecycle.renewal.due";
/// Something expired.
pub const EVENT_EXPIRY_EXPIRED: &str = "lifecycle.expiry.expired";
/// A responder reissued the subject.
pub const EVENT_RENEWAL_SUCCEEDED: &str = "lifecycle.renewal.succeeded";
/// A responder tried and failed. Emitted so an operator or an external tool
/// can take over — a failed renewal is never swallowed.
pub const EVENT_RENEWAL_FAILED: &str = "lifecycle.renewal.failed";

/// Every event type a hook may subscribe to.
pub const LIFECYCLE_EVENT_TYPES: &[&str] = &[
    EVENT_EXPIRY_NOTICE,
    EVENT_EXPIRY_WARNING,
    EVENT_EXPIRY_URGENT,
    EVENT_RENEWAL_DUE,
    EVENT_EXPIRY_EXPIRED,
    EVENT_RENEWAL_SUCCEEDED,
    EVENT_RENEWAL_FAILED,
];

/// Subscription wildcard: every lifecycle event.
pub const EVENT_WILDCARD: &str = "lifecycle.*";

/// Longest operator label carried into a payload.
pub const MAX_LABEL_CHARS: usize = 128;
/// Longest responder detail carried into a payload — a hint, never material.
pub const MAX_DETAIL_CHARS: usize = 160;

#[must_use]
pub fn is_lifecycle_event_type(event_type: &str) -> bool {
    LIFECYCLE_EVENT_TYPES.contains(&event_type)
}

/// Whether a subscription filter selects `event_type`.
///
/// A filter is a list of exact event types and/or [`EVENT_WILDCARD`]. An empty
/// filter matches nothing: a hook that names no events is a misconfiguration,
/// and defaulting it to "everything" would be the wrong direction to fail.
#[must_use]
pub fn filter_matches(filter: &[String], event_type: &str) -> bool {
    filter
        .iter()
        .any(|entry| entry == EVENT_WILDCARD || entry == event_type)
}

/// Whether every entry in a subscription filter is a name we recognise.
#[must_use]
pub fn filter_is_valid(filter: &[String]) -> bool {
    !filter.is_empty()
        && filter
            .iter()
            .all(|entry| entry == EVENT_WILDCARD || is_lifecycle_event_type(entry))
}

fn truncate(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

/// The event type a ladder rung publishes under.
#[must_use]
pub const fn event_type_for_stage(stage: ExpiryStage) -> &'static str {
    match stage {
        ExpiryStage::Notice => EVENT_EXPIRY_NOTICE,
        ExpiryStage::Warning => EVENT_EXPIRY_WARNING,
        ExpiryStage::Urgent => EVENT_EXPIRY_URGENT,
        ExpiryStage::Renewal => EVENT_RENEWAL_DUE,
        ExpiryStage::Expired => EVENT_EXPIRY_EXPIRED,
    }
}

/// A lifecycle fact, ready to be recorded and fanned out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleEvent {
    pub event_type: String,
    pub stage: ExpiryStage,
    pub subject: ExpirySubject,
    pub occurred_at: DateTime<Utc>,
    /// Seconds until expiry when the event fired; negative once expired.
    pub remaining_seconds: i64,
    /// Operator hint from a responder outcome. Never credential material.
    pub detail: Option<String>,
}

impl LifecycleEvent {
    /// Build the event for a crossed ladder rung.
    #[must_use]
    pub fn for_stage(subject: ExpirySubject, stage: ExpiryStage, now: DateTime<Utc>) -> Self {
        let remaining_seconds = subject.remaining_seconds(now);
        Self {
            event_type: event_type_for_stage(stage).to_string(),
            stage,
            subject,
            occurred_at: now,
            remaining_seconds,
            detail: None,
        }
    }

    /// Build a responder-outcome event (`succeeded` / `failed`).
    #[must_use]
    pub fn for_outcome(
        subject: ExpirySubject,
        stage: ExpiryStage,
        now: DateTime<Utc>,
        succeeded: bool,
        detail: Option<&str>,
    ) -> Self {
        let mut event = Self::for_stage(subject, stage, now);
        event.event_type = if succeeded {
            EVENT_RENEWAL_SUCCEEDED.to_string()
        } else {
            EVENT_RENEWAL_FAILED.to_string()
        };
        event.detail = detail.map(|raw| truncate(raw, MAX_DETAIL_CHARS));
        event
    }

    /// Whether this is a ladder rung rather than a responder's own outcome.
    ///
    /// An outcome keeps the stage that produced it — that is how a subscriber
    /// knows which rung was acted on — so the event type is the only thing
    /// that distinguishes the two.
    #[must_use]
    pub fn is_ladder_event(&self) -> bool {
        self.event_type == event_type_for_stage(self.stage)
    }

    /// The wire payload. Built field by field from metadata — never by
    /// serializing an arbitrary struct — so a field added upstream cannot
    /// reach a subscriber without a deliberate edit here.
    #[must_use]
    pub fn payload(&self) -> Value {
        let mut body = Map::new();
        body.insert("event_type".into(), json!(self.event_type));
        body.insert("stage".into(), json!(self.stage.as_str()));
        body.insert("subject_kind".into(), json!(self.subject.kind.as_str()));
        body.insert("subject_id".into(), json!(self.subject.subject_id));
        body.insert(
            "organization_id".into(),
            json!(self.subject.organization_id),
        );
        body.insert(
            "expires_at".into(),
            json!(self.subject.expires_at.to_rfc3339()),
        );
        body.insert("occurred_at".into(), json!(self.occurred_at.to_rfc3339()));
        body.insert("remaining_seconds".into(), json!(self.remaining_seconds));
        body.insert(
            "renew_before_seconds".into(),
            json!(self.subject.renew_before()),
        );
        body.insert("auto_respond".into(), json!(self.subject.auto_respond));
        // Explicit non-disclosure, mirroring the rotation routes: a subscriber
        // never has to infer that this feed is value-blind.
        body.insert("secrets_returned".into(), json!(false));
        if let Some(label) = &self.subject.label {
            body.insert("label".into(), json!(truncate(label, MAX_LABEL_CHARS)));
        }
        if let Some(detail) = &self.detail {
            body.insert("detail".into(), json!(truncate(detail, MAX_DETAIL_CHARS)));
        }
        Value::Object(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subject::SubjectKind;

    fn now() -> DateTime<Utc> {
        "2026-08-30T00:00:00Z".parse().unwrap()
    }

    fn subject() -> ExpirySubject {
        ExpirySubject {
            kind: SubjectKind::Certificate,
            subject_id: "cert-1".into(),
            organization_id: "org-1".into(),
            expires_at: "2026-09-06T00:00:00Z".parse().unwrap(),
            renew_before_seconds: Some(86_400),
            auto_respond: true,
            alerting: true,
            label: Some("api.example.com".into()),
        }
    }

    #[test]
    fn event_names_are_frozen() {
        assert_eq!(
            LIFECYCLE_EVENT_TYPES,
            &[
                "lifecycle.expiry.notice",
                "lifecycle.expiry.warning",
                "lifecycle.expiry.urgent",
                "lifecycle.renewal.due",
                "lifecycle.expiry.expired",
                "lifecycle.renewal.succeeded",
                "lifecycle.renewal.failed",
            ],
        );
    }

    #[test]
    fn every_stage_maps_to_a_known_event_type() {
        for stage in ExpiryStage::ALL {
            assert!(is_lifecycle_event_type(event_type_for_stage(stage)));
        }
    }

    #[test]
    fn filters_match_exactly_or_by_wildcard() {
        let exact = vec![EVENT_RENEWAL_DUE.to_string()];
        assert!(filter_matches(&exact, EVENT_RENEWAL_DUE));
        assert!(!filter_matches(&exact, EVENT_EXPIRY_EXPIRED));

        let wildcard = vec![EVENT_WILDCARD.to_string()];
        for event_type in LIFECYCLE_EVENT_TYPES {
            assert!(filter_matches(&wildcard, event_type));
        }
    }

    #[test]
    fn an_empty_filter_matches_nothing_and_is_invalid() {
        assert!(!filter_matches(&[], EVENT_RENEWAL_DUE));
        assert!(!filter_is_valid(&[]));
    }

    #[test]
    fn unknown_filter_entries_are_refused() {
        assert!(!filter_is_valid(&["lifecycle.expiry.imminent".into()]));
        assert!(filter_is_valid(&[EVENT_WILDCARD.into()]));
    }

    #[test]
    fn payload_is_value_blind() {
        let event = LifecycleEvent::for_stage(subject(), ExpiryStage::Renewal, now());
        let payload = event.payload();
        let object = payload.as_object().unwrap();
        assert_eq!(object["event_type"], json!(EVENT_RENEWAL_DUE));
        assert_eq!(object["secrets_returned"], json!(false));
        for key in object.keys() {
            for forbidden in [
                "secret", "password", "token", "api_key", "private_key", "credential",
            ] {
                assert!(
                    !key.contains(forbidden) || key == "secrets_returned",
                    "payload grew a secret-shaped key: {key}",
                );
            }
        }
    }

    #[test]
    fn payload_truncates_labels_and_details() {
        let mut s = subject();
        s.label = Some("x".repeat(MAX_LABEL_CHARS * 2));
        let event = LifecycleEvent::for_outcome(
            s,
            ExpiryStage::Renewal,
            now(),
            false,
            Some(&"y".repeat(MAX_DETAIL_CHARS * 2)),
        );
        let payload = event.payload();
        assert_eq!(
            payload["label"].as_str().unwrap().chars().count(),
            MAX_LABEL_CHARS,
        );
        assert_eq!(
            payload["detail"].as_str().unwrap().chars().count(),
            MAX_DETAIL_CHARS,
        );
        assert_eq!(payload["event_type"], json!(EVENT_RENEWAL_FAILED));
    }

    #[test]
    fn ladder_events_and_outcomes_are_distinguishable() {
        let rung = LifecycleEvent::for_stage(subject(), ExpiryStage::Renewal, now());
        assert!(rung.is_ladder_event());
        let outcome =
            LifecycleEvent::for_outcome(subject(), ExpiryStage::Renewal, now(), true, None);
        assert!(!outcome.is_ladder_event());
        assert_eq!(outcome.stage, rung.stage, "an outcome keeps its rung");
    }

    #[test]
    fn a_successful_outcome_reports_the_success_type() {
        let event =
            LifecycleEvent::for_outcome(subject(), ExpiryStage::Renewal, now(), true, Some("ok"));
        assert_eq!(event.event_type, EVENT_RENEWAL_SUCCEEDED);
        assert_eq!(event.payload()["detail"], json!("ok"));
    }
}
