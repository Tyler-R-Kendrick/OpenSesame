//! Frozen `breach.*` hook event names and their value-blind payloads.
//!
//! Frozen in the same sense as the lifecycle plane's names: additive only,
//! never renamed, and pinned by a unit test so a refactor cannot quietly break
//! every registered hook.
//!
//! A payload is assembled key by key from metadata, never by serializing
//! whatever a caller passed in. The one number that comes from the corpus —
//! how many times a password appears in it — is a property of the corpus, not
//! of the secret, and is what makes a finding actionable.

use chrono::{DateTime, Utc};
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::catalogue::Breach;
use crate::source::BreachSource;
use crate::subject::{BreachSubject, BreachSubjectKind};

/// A stored secret appears in a public breach corpus. Rotate it.
pub const EVENT_PASSWORD_COMPROMISED: &str = "breach.password.compromised";
/// A watched provider domain appears in a newly published breach.
pub const EVENT_PROVIDER_DISCLOSED: &str = "breach.provider.disclosed";
/// A previously reported finding no longer reproduces — the secret was
/// rotated, or the entry was withdrawn. This is what closes an open alert.
pub const EVENT_FINDING_CLEARED: &str = "breach.finding.cleared";
/// A trusted source could not be consulted. Published rather than logged: a
/// scanner that silently stops checking is worse than one that never ran, and
/// the only way an operator finds out is if the gap is on the feed.
pub const EVENT_SCAN_FAILED: &str = "breach.scan.failed";

/// Every event type a hook may subscribe to.
pub const BREACH_EVENT_TYPES: &[&str] = &[
    EVENT_PASSWORD_COMPROMISED,
    EVENT_PROVIDER_DISCLOSED,
    EVENT_FINDING_CLEARED,
    EVENT_SCAN_FAILED,
];

/// Subscription wildcard: every breach event.
pub const EVENT_WILDCARD: &str = "breach.*";

/// Longest operator label carried into a payload.
pub const MAX_LABEL_CHARS: usize = 128;
/// Longest detail hint carried into a payload — a hint, never material.
pub const MAX_DETAIL_CHARS: usize = 160;

#[must_use]
pub fn is_breach_event_type(event_type: &str) -> bool {
    BREACH_EVENT_TYPES.contains(&event_type)
}

fn truncate(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

/// A breach finding, ready to be recorded and fanned out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BreachEvent {
    pub event_type: String,
    pub source: BreachSource,
    pub subject: BreachSubject,
    pub severity: Severity,
    pub occurred_at: DateTime<Utc>,
    /// How many times the corpus has seen this password. A property of the
    /// corpus; it says nothing about the secret's content.
    pub occurrences: Option<u64>,
    /// The breach's published name, for a disclosure.
    pub reference: Option<String>,
    /// Operator hint. Never credential material.
    pub detail: Option<String>,
}

impl BreachEvent {
    fn base(event_type: &str, source: BreachSource, subject: BreachSubject) -> Self {
        Self {
            event_type: event_type.to_string(),
            source,
            subject,
            severity: Severity::Warning,
            occurred_at: Utc::now(),
            occurrences: None,
            reference: None,
            detail: None,
        }
    }

    /// A stored secret matched the password corpus.
    ///
    /// Always `Critical`: a credential that is both live and public is the
    /// single loudest thing this platform can discover about itself.
    #[must_use]
    pub fn password_compromised(
        subject: BreachSubject,
        occurrences: u64,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            severity: Severity::Critical,
            occurred_at: now,
            occurrences: Some(occurrences),
            ..Self::base(
                EVENT_PASSWORD_COMPROMISED,
                BreachSource::HibpPasswords,
                subject,
            )
        }
    }

    /// A watched domain appeared in a published breach.
    #[must_use]
    pub fn provider_disclosed(subject: BreachSubject, breach: &Breach, now: DateTime<Utc>) -> Self {
        Self {
            severity: breach.severity(),
            occurred_at: now,
            reference: Some(truncate(breach.display_name(), MAX_LABEL_CHARS)),
            detail: Some(truncate(&disclosure_detail(breach), MAX_DETAIL_CHARS)),
            ..Self::base(
                EVENT_PROVIDER_DISCLOSED,
                BreachSource::HibpBreaches,
                subject,
            )
        }
    }

    /// A finding no longer reproduces. Resolves whatever it opened.
    #[must_use]
    pub fn cleared(subject: BreachSubject, source: BreachSource, now: DateTime<Utc>) -> Self {
        Self {
            severity: Severity::Info,
            occurred_at: now,
            ..Self::base(EVENT_FINDING_CLEARED, source, subject)
        }
    }

    /// A source could not be consulted.
    #[must_use]
    pub fn scan_failed(
        source: BreachSource,
        organization_id: impl Into<String>,
        detail: &str,
        now: DateTime<Utc>,
    ) -> Self {
        let subject =
            BreachSubject::new(BreachSubjectKind::Source, source.as_str(), organization_id)
                .labelled(source.title());
        Self {
            severity: Severity::Warning,
            occurred_at: now,
            detail: Some(truncate(detail, MAX_DETAIL_CHARS)),
            ..Self::base(EVENT_SCAN_FAILED, source, subject)
        }
    }

    /// Whether this event settles a condition rather than raising one.
    #[must_use]
    pub fn is_resolution(&self) -> bool {
        self.event_type == EVENT_FINDING_CLEARED
    }

    /// The operator-facing name of the subject.
    #[must_use]
    fn subject_name(&self) -> &str {
        self.subject
            .label
            .as_deref()
            .unwrap_or(&self.subject.subject_id)
    }

    /// One line a human reads first.
    #[must_use]
    pub fn summary(&self) -> String {
        let name = self.subject_name();
        match self.event_type.as_str() {
            EVENT_PASSWORD_COMPROMISED => format!(
                "the secret at {name} appears in {} ({} occurrence(s)); rotate it",
                self.source.title(),
                self.occurrences.unwrap_or_default(),
            ),
            EVENT_PROVIDER_DISCLOSED => format!(
                "{} was published as breached and affects {name}",
                self.reference.as_deref().unwrap_or("a provider"),
            ),
            EVENT_FINDING_CLEARED => {
                format!("{name} no longer matches {}", self.source.title())
            }
            EVENT_SCAN_FAILED => format!(
                "{} could not be consulted; breach coverage is degraded",
                self.source.title(),
            ),
            other => format!("{other} for {name}"),
        }
    }

    /// The wire payload. Built field by field from metadata — never by
    /// serializing an arbitrary struct — so a field added upstream cannot
    /// reach a subscriber without a deliberate edit here.
    #[must_use]
    pub fn payload(&self) -> Value {
        let mut body = Map::new();
        body.insert("event_type".into(), json!(self.event_type));
        body.insert("source".into(), json!(self.source.as_str()));
        body.insert("severity".into(), json!(self.severity.as_str()));
        body.insert("subject_kind".into(), json!(self.subject.kind.as_str()));
        body.insert("subject_id".into(), json!(self.subject.subject_id));
        body.insert(
            "organization_id".into(),
            json!(self.subject.organization_id),
        );
        body.insert("occurred_at".into(), json!(self.occurred_at.to_rfc3339()));
        // Explicit non-disclosure, mirroring the lifecycle feed: a subscriber
        // never has to infer that this feed is value-blind. It matters more
        // here than anywhere — this is the feed that talks about passwords.
        body.insert("secrets_returned".into(), json!(false));
        if let Some(occurrences) = self.occurrences {
            body.insert("occurrences".into(), json!(occurrences));
        }
        if let Some(reference) = &self.reference {
            body.insert(
                "breach_reference".into(),
                json!(truncate(reference, MAX_LABEL_CHARS)),
            );
        }
        if let Some(label) = &self.subject.label {
            body.insert("label".into(), json!(truncate(label, MAX_LABEL_CHARS)));
        }
        if let Some(detail) = &self.detail {
            body.insert("detail".into(), json!(truncate(detail, MAX_DETAIL_CHARS)));
        }
        Value::Object(body)
    }

    /// The normalized envelope the notifier, the alerter, and every sink read.
    #[must_use]
    pub fn notice(&self) -> SecurityNotice {
        SecurityNotice {
            event_type: self.event_type.clone(),
            severity: self.severity,
            state: if self.is_resolution() {
                NoticeState::Resolved
            } else {
                NoticeState::Firing
            },
            organization_id: self.subject.organization_id.clone(),
            subject_kind: self.subject.kind.as_str().to_string(),
            subject_id: self.subject.subject_id.clone(),
            label: self.subject.label.clone(),
            occurred_at: self.occurred_at,
            summary: self.summary(),
            detail: self.detail.clone(),
            payload: self.payload(),
        }
    }
}

/// A one-line description of what a disclosure exposed.
fn disclosure_detail(breach: &Breach) -> String {
    let classes = if breach.data_classes.is_empty() {
        "unspecified data".to_string()
    } else {
        breach.data_classes.join(", ")
    };
    format!("exposed {classes}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-08-30T00:00:00Z".parse().unwrap()
    }

    fn store_subject() -> BreachSubject {
        BreachSubject::new(BreachSubjectKind::StorePath, "Dev/api-token", "org-1")
            .labelled("Dev/api-token")
    }

    fn breach() -> Breach {
        Breach {
            name: "Adobe".into(),
            title: "Adobe".into(),
            domain: "adobe.com".into(),
            data_classes: vec!["Email addresses".into(), "Passwords".into()],
            is_verified: true,
            ..Breach::default()
        }
    }

    #[test]
    fn event_names_are_frozen() {
        assert_eq!(
            BREACH_EVENT_TYPES,
            &[
                "breach.password.compromised",
                "breach.provider.disclosed",
                "breach.finding.cleared",
                "breach.scan.failed",
            ],
        );
    }

    #[test]
    fn every_frozen_name_is_recognised_and_lives_under_the_wildcard() {
        for event_type in BREACH_EVENT_TYPES {
            assert!(is_breach_event_type(event_type));
            let family = EVENT_WILDCARD.trim_end_matches(".*");
            assert!(event_type.starts_with(family), "{event_type}");
        }
        assert!(!is_breach_event_type("breach.account.compromised"));
    }

    #[test]
    fn a_compromised_password_is_always_critical() {
        let event = BreachEvent::password_compromised(store_subject(), 42, now());
        assert_eq!(event.severity, Severity::Critical);
        assert_eq!(event.occurrences, Some(42));
        assert_eq!(event.source, BreachSource::HibpPasswords);
    }

    #[test]
    fn a_disclosure_inherits_the_breachs_own_severity() {
        let event = BreachEvent::provider_disclosed(
            BreachSubject::new(BreachSubjectKind::Domain, "adobe.com", "org-1"),
            &breach(),
            now(),
        );
        assert_eq!(event.severity, Severity::Error);
        assert_eq!(event.reference.as_deref(), Some("Adobe"));
        assert!(event.detail.unwrap().contains("Passwords"));
    }

    #[test]
    fn a_disclosure_without_passwords_is_only_a_warning() {
        let mut mild = breach();
        mild.data_classes = vec!["Email addresses".into()];
        let event = BreachEvent::provider_disclosed(
            BreachSubject::new(BreachSubjectKind::Domain, "adobe.com", "org-1"),
            &mild,
            now(),
        );
        assert_eq!(event.severity, Severity::Warning);
    }

    #[test]
    fn a_cleared_finding_resolves_and_a_live_one_does_not() {
        let cleared = BreachEvent::cleared(store_subject(), BreachSource::HibpPasswords, now());
        assert!(cleared.is_resolution());
        assert_eq!(cleared.notice().state, NoticeState::Resolved);

        let live = BreachEvent::password_compromised(store_subject(), 1, now());
        assert!(!live.is_resolution());
        assert_eq!(live.notice().state, NoticeState::Firing);
    }

    #[test]
    fn a_clear_resolves_the_alert_the_finding_opened() {
        let found = BreachEvent::password_compromised(store_subject(), 42, now()).notice();
        let cleared =
            BreachEvent::cleared(store_subject(), BreachSource::HibpPasswords, now()).notice();
        assert_eq!(found.alert_key(), cleared.alert_key());
    }

    #[test]
    fn a_failed_scan_reports_against_the_source_itself() {
        let event = BreachEvent::scan_failed(
            BreachSource::HibpBreaches,
            "org-1",
            "connection timed out",
            now(),
        );
        assert_eq!(event.subject.kind, BreachSubjectKind::Source);
        assert_eq!(event.subject.subject_id, "hibp_breaches");
        assert_eq!(event.severity, Severity::Warning);
        assert!(event.summary().contains("coverage is degraded"));
    }

    #[test]
    fn payload_is_value_blind() {
        let event = BreachEvent::password_compromised(store_subject(), 42, now());
        let payload = event.payload();
        let object = payload.as_object().unwrap();
        assert_eq!(object["secrets_returned"], json!(false));
        assert_eq!(object["occurrences"], json!(42));
        for key in object.keys() {
            for forbidden in ["password", "api_key", "private_key", "plaintext"] {
                assert!(!key.contains(forbidden), "payload grew {key}");
            }
        }
        assert!(
            object.keys().all(|key| key == "secrets_returned"
                || (!key.contains("secret") && !key.contains("credential"))),
            "payload grew a secret-shaped key",
        );
    }

    #[test]
    fn payload_truncates_labels_references_and_details() {
        let long = BreachSubject::new(BreachSubjectKind::StorePath, "id", "org-1")
            .labelled("x".repeat(MAX_LABEL_CHARS * 2));
        let mut event = BreachEvent::password_compromised(long, 1, now());
        event.reference = Some("r".repeat(MAX_LABEL_CHARS * 2));
        event.detail = Some("d".repeat(MAX_DETAIL_CHARS * 2));
        let payload = event.payload();
        assert_eq!(
            payload["label"].as_str().unwrap().chars().count(),
            MAX_LABEL_CHARS
        );
        assert_eq!(
            payload["breach_reference"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_LABEL_CHARS,
        );
        assert_eq!(
            payload["detail"].as_str().unwrap().chars().count(),
            MAX_DETAIL_CHARS,
        );
    }

    #[test]
    fn the_notice_carries_the_events_own_payload_and_summary() {
        let event = BreachEvent::password_compromised(store_subject(), 42, now());
        let notice = event.notice();
        assert_eq!(notice.event_type, EVENT_PASSWORD_COMPROMISED);
        assert_eq!(notice.severity, Severity::Critical);
        assert_eq!(notice.subject_kind, "store_path");
        assert_eq!(notice.payload, event.payload());
        assert!(notice.summary.contains("rotate it"));
    }

    #[test]
    fn every_event_type_produces_a_non_empty_summary() {
        let events = [
            BreachEvent::password_compromised(store_subject(), 1, now()),
            BreachEvent::provider_disclosed(
                BreachSubject::new(BreachSubjectKind::Domain, "adobe.com", "org-1"),
                &breach(),
                now(),
            ),
            BreachEvent::cleared(store_subject(), BreachSource::HibpPasswords, now()),
            BreachEvent::scan_failed(BreachSource::HibpBreaches, "org-1", "boom", now()),
        ];
        for event in events {
            assert!(!event.summary().is_empty(), "{}", event.event_type);
            assert!(is_breach_event_type(&event.event_type));
        }
    }
}
