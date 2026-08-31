//! The one shape every security event becomes before it is notified or alerted.
//!
//! An expiring certificate, a password found in a breach corpus, and a
//! credential whose provider announced an incident are different facts with
//! different payloads. What they have in common is what a notifier and an
//! alerter need: who it is about, how loud it is, whether it is starting or
//! ending, and one line a human can read. That is a [`SecurityNotice`].
//!
//! Normalizing here is what makes the pattern *one* pattern. A new event
//! family implements a conversion into this type and immediately inherits the
//! hook feed, the delivery ledger, the built-in notifier, the built-in
//! alerter, and every industry-standard sink — without any of them learning
//! that the family exists.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::severity::Severity;

/// Longest summary line carried to a sink.
///
/// `PagerDuty` truncates `payload.summary` at 1024 characters; truncating here
/// instead means every sink shows the same text rather than one of them
/// silently showing less.
pub const MAX_SUMMARY_CHARS: usize = 1_024;
/// Longest operator label carried to a sink.
pub const MAX_LABEL_CHARS: usize = 128;
/// Longest detail hint carried to a sink. A hint, never material.
pub const MAX_DETAIL_CHARS: usize = 160;

/// Longest alert key a sink will accept.
///
/// `PagerDuty` rejects a `dedup_key` over 255 characters with a 400, which the
/// delivery worker reads as permanent and dead-letters. A subject id alone is
/// allowed to be 256, so the natural key can exceed this — bounding it here is
/// what keeps a long store path from silently never paging anyone.
pub const MAX_ALERT_KEY_CHARS: usize = 255;

/// Hex characters of digest appended to a truncated alert key.
const ALERT_KEY_DIGEST_CHARS: usize = 32;

/// Substrings that must never appear in a payload key reaching a sink.
///
/// Defense in depth, not the primary control. Each event family builds its
/// payload key by key from metadata and carries its own structural test; this
/// is the second fence, so a family added later without that discipline still
/// cannot leak a value through a notification.
const SECRET_SHAPED: [&str; 9] = [
    "secret",
    "password",
    "passphrase",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "credential",
    "plaintext",
];

/// Whether the condition is beginning or has been settled.
///
/// Both sinks that hold state need this: Alertmanager resolves an alert whose
/// `endsAt` has passed, `PagerDuty` by `event_action: "resolve"`. Without it an
/// expiry page stays open after the certificate has been renewed, and an
/// operator learns to ignore the feed — which is the failure mode that makes
/// alerting worthless.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NoticeState {
    /// The condition is live.
    Firing,
    /// The condition that fired has been settled — renewed, rotated, cleared.
    Resolved,
}

impl NoticeState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Firing => "firing",
            Self::Resolved => "resolved",
        }
    }

    #[must_use]
    pub const fn is_resolved(self) -> bool {
        matches!(self, Self::Resolved)
    }
}

/// A security event, normalized for notification and alerting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecurityNotice {
    /// The frozen event name the hook filter matched, e.g.
    /// `lifecycle.renewal.due` or `breach.password.compromised`.
    pub event_type: String,
    pub severity: Severity,
    pub state: NoticeState,
    pub organization_id: String,
    /// What the event is about, as a wire name — `certificate`, `store_path`,
    /// `account`, …. Never a value.
    pub subject_kind: String,
    /// Stable identity within `(organization_id, subject_kind)`.
    pub subject_id: String,
    /// Operator-facing name. Never a credential.
    pub label: Option<String>,
    pub occurred_at: DateTime<Utc>,
    /// One line a human reads first.
    pub summary: String,
    /// Extra operator hint. Never material.
    pub detail: Option<String>,
    /// The source family's own value-blind payload, carried through for
    /// subscribers that want the specifics.
    pub payload: Value,
}

/// A short, stable hex digest used to disambiguate a truncated alert key.
fn short_digest(raw: &str) -> String {
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(ALERT_KEY_DIGEST_CHARS / 2)
        .fold(
            String::with_capacity(ALERT_KEY_DIGEST_CHARS),
            |mut out, byte| {
                use std::fmt::Write as _;
                let _ = write!(out, "{byte:02x}");
                out
            },
        )
}

fn truncate(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

/// Whether a payload key is shaped like it might carry a value.
///
/// `secrets_returned` is the deliberate exception: it is the explicit
/// non-disclosure marker the event families set to `false`, and stripping it
/// would remove the very statement that the feed is value-blind.
fn is_secret_shaped(key: &str) -> bool {
    if key == "secrets_returned" {
        return false;
    }
    let lowered = key.to_ascii_lowercase();
    SECRET_SHAPED
        .iter()
        .any(|forbidden| lowered.contains(forbidden))
}

impl SecurityNotice {
    /// The family a notice belongs to — the first segment of its event type.
    ///
    /// Used to group alerts, so every event about one subject within one
    /// family shares an alert identity and a later resolve actually closes the
    /// page an earlier fire opened.
    #[must_use]
    pub fn family(&self) -> &str {
        self.event_type
            .split_once('.')
            .map_or(self.event_type.as_str(), |(family, _)| family)
    }

    /// Stable identity for the alert this notice opens or closes.
    ///
    /// Keyed on the subject rather than the event type on purpose: a
    /// certificate that warned at 7 days and again at 24 hours is one problem,
    /// and its renewal must close both. Every character comes from metadata,
    /// so the key is safe to send to a third-party alerting service.
    #[must_use]
    pub fn alert_key(&self) -> String {
        let natural = format!(
            "{}:{}:{}:{}",
            self.family(),
            self.organization_id,
            self.subject_kind,
            self.subject_id,
        );
        if natural.chars().count() <= MAX_ALERT_KEY_CHARS {
            return natural;
        }
        // Truncating alone would merge two subjects that share a long prefix
        // into one incident — two different exposed secrets under one page,
        // one of which nobody ever looks at. The digest of the *whole* key
        // keeps them distinct while fitting the cap.
        //
        // This is a deduplication identifier, not a security control: the
        // digest is here to avoid collisions, and nothing is authenticated by
        // it.
        let digest = short_digest(&natural);
        let head: String = natural
            .chars()
            .take(MAX_ALERT_KEY_CHARS - ALERT_KEY_DIGEST_CHARS - 1)
            .collect();
        format!("{head}~{digest}")
    }

    /// The summary, bounded to what every sink will show.
    #[must_use]
    pub fn summary_text(&self) -> String {
        truncate(&self.summary, MAX_SUMMARY_CHARS)
    }

    /// The label, bounded.
    #[must_use]
    pub fn label_text(&self) -> Option<String> {
        self.label
            .as_ref()
            .map(|label| truncate(label, MAX_LABEL_CHARS))
    }

    /// The detail hint, bounded.
    #[must_use]
    pub fn detail_text(&self) -> Option<String> {
        self.detail
            .as_ref()
            .map(|detail| truncate(detail, MAX_DETAIL_CHARS))
    }

    /// The source payload with any secret-shaped key removed.
    ///
    /// Shallow by design: every event family builds a flat payload, and a
    /// recursive walk would invite someone to nest one and assume this will
    /// catch it. If a family ever needs nesting, this fence has to be widened
    /// deliberately rather than trusted silently.
    #[must_use]
    pub fn safe_payload(&self) -> Value {
        let Some(object) = self.payload.as_object() else {
            // A non-object payload has no keys to vet, so it cannot be shown
            // to be value-blind. Drop it rather than forward it.
            return Value::Object(Map::new());
        };
        let kept = object
            .iter()
            .filter(|(key, _)| !is_secret_shaped(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        Value::Object(kept)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn notice() -> SecurityNotice {
        SecurityNotice {
            event_type: "lifecycle.expiry.urgent".into(),
            severity: Severity::Error,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "certificate".into(),
            subject_id: "cert-1".into(),
            label: Some("api.example.com".into()),
            occurred_at: "2026-08-30T00:00:00Z".parse().unwrap(),
            summary: "certificate api.example.com expires in 18 hours".into(),
            detail: None,
            payload: json!({"remaining_seconds": 64_800, "secrets_returned": false}),
        }
    }

    #[test]
    fn the_family_is_the_first_event_segment() {
        assert_eq!(notice().family(), "lifecycle");
        let mut breach = notice();
        breach.event_type = "breach.password.compromised".into();
        assert_eq!(breach.family(), "breach");
    }

    #[test]
    fn an_event_type_without_a_dot_is_its_own_family() {
        let mut odd = notice();
        odd.event_type = "standalone".into();
        assert_eq!(odd.family(), "standalone");
    }

    #[test]
    fn a_short_alert_key_is_left_exactly_as_it_reads() {
        assert_eq!(notice().alert_key(), "lifecycle:org-1:certificate:cert-1");
    }

    #[test]
    fn a_long_alert_key_is_bounded_to_what_pagerduty_accepts() {
        let mut long = notice();
        long.subject_id = "p".repeat(400);
        let key = long.alert_key();
        assert_eq!(key.chars().count(), MAX_ALERT_KEY_CHARS);
    }

    #[test]
    fn two_long_subjects_sharing_a_prefix_stay_separate_incidents() {
        let mut first = notice();
        first.subject_id = format!("{}/alpha", "p".repeat(400));
        let mut second = notice();
        second.subject_id = format!("{}/beta", "p".repeat(400));
        assert_ne!(
            first.alert_key(),
            second.alert_key(),
            "truncation must not merge two exposed secrets into one page",
        );
    }

    #[test]
    fn a_bounded_alert_key_is_stable_across_calls() {
        let mut long = notice();
        long.subject_id = "p".repeat(400);
        assert_eq!(long.alert_key(), long.alert_key());
    }

    #[test]
    fn a_bounded_alert_key_still_resolves_the_alert_it_opened() {
        let mut firing = notice();
        firing.subject_id = "p".repeat(400);
        let mut resolved = firing.clone();
        resolved.event_type = "lifecycle.renewal.succeeded".into();
        resolved.state = NoticeState::Resolved;
        assert_eq!(firing.alert_key(), resolved.alert_key());
    }

    #[test]
    fn one_subject_keeps_one_alert_identity_across_rungs() {
        let mut urgent = notice();
        urgent.event_type = "lifecycle.expiry.urgent".into();
        let mut renewed = notice();
        renewed.event_type = "lifecycle.renewal.succeeded".into();
        renewed.state = NoticeState::Resolved;
        assert_eq!(
            urgent.alert_key(),
            renewed.alert_key(),
            "a renewal must close the page its expiry opened",
        );
    }

    #[test]
    fn different_subjects_never_share_an_alert_identity() {
        let first = notice();
        let mut second = notice();
        second.subject_id = "cert-2".into();
        assert_ne!(first.alert_key(), second.alert_key());
    }

    #[test]
    fn a_breach_and_an_expiry_on_one_subject_are_separate_alerts() {
        let expiry = notice();
        let mut breach = notice();
        breach.event_type = "breach.password.compromised".into();
        assert_ne!(
            expiry.alert_key(),
            breach.alert_key(),
            "renewing a certificate must not resolve a breach finding",
        );
    }

    #[test]
    fn secret_shaped_payload_keys_are_stripped() {
        let mut leaky = notice();
        leaky.payload = json!({
            "remaining_seconds": 10,
            "password": "hunter2",
            "API_KEY": "sk-live",
            "refresh_token": "rt",
            "secrets_returned": false,
        });
        let safe = leaky.safe_payload();
        let object = safe.as_object().unwrap();
        assert_eq!(object.len(), 2);
        assert!(object.contains_key("remaining_seconds"));
        assert!(
            object.contains_key("secrets_returned"),
            "the non-disclosure marker is the one 'secret'-shaped key that stays",
        );
    }

    #[test]
    fn a_payload_that_is_not_an_object_is_dropped_entirely() {
        let mut odd = notice();
        odd.payload = json!("hunter2");
        assert_eq!(odd.safe_payload(), json!({}));
    }

    #[test]
    fn long_text_is_bounded_before_it_reaches_a_sink() {
        let mut long = notice();
        long.summary = "s".repeat(MAX_SUMMARY_CHARS * 2);
        long.label = Some("l".repeat(MAX_LABEL_CHARS * 2));
        long.detail = Some("d".repeat(MAX_DETAIL_CHARS * 2));
        assert_eq!(long.summary_text().chars().count(), MAX_SUMMARY_CHARS);
        assert_eq!(long.label_text().unwrap().chars().count(), MAX_LABEL_CHARS);
        assert_eq!(
            long.detail_text().unwrap().chars().count(),
            MAX_DETAIL_CHARS
        );
    }

    #[test]
    fn an_alert_key_carries_only_metadata() {
        let key = notice().alert_key();
        assert_eq!(key, "lifecycle:org-1:certificate:cert-1");
    }
}
