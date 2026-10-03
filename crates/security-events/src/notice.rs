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
use opensesame_redaction::{redact_json, redact_text};
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

    /// The summary, scrubbed and bounded to what every sink will show.
    ///
    /// Scrubbed *before* it is cut: truncating first could leave the front of
    /// a token that no pattern recognises any more.
    #[must_use]
    pub fn summary_text(&self) -> String {
        truncate(&redact_text(&self.summary), MAX_SUMMARY_CHARS)
    }

    /// The label, scrubbed and bounded.
    #[must_use]
    pub fn label_text(&self) -> Option<String> {
        self.label
            .as_ref()
            .map(|label| truncate(&redact_text(label), MAX_LABEL_CHARS))
    }

    /// The detail hint, scrubbed and bounded.
    #[must_use]
    pub fn detail_text(&self) -> Option<String> {
        self.detail
            .as_ref()
            .map(|detail| truncate(&redact_text(detail), MAX_DETAIL_CHARS))
    }

    /// The subject id, scrubbed. A store path or a domain is metadata, but it
    /// is operator- or provider-supplied text, and it goes to third parties.
    #[must_use]
    pub fn subject_id_text(&self) -> String {
        redact_text(&self.subject_id)
    }

    /// The source payload with every secret-shaped key removed at any depth
    /// and every string scrubbed (ADR 0156).
    ///
    /// Families build flat payloads today, but a nested one must not be the way
    /// around this fence, so the walk is recursive rather than trusted.
    #[must_use]
    pub fn safe_payload(&self) -> Value {
        let Some(object) = self.payload.as_object() else {
            // A non-object payload has no keys to vet, so it cannot be shown
            // to be value-blind. Drop it rather than forward it.
            return Value::Object(Map::new());
        };
        redact_json(&Value::Object(strip_secret_keys(object)))
    }

    /// A copy with every free-text field scrubbed. `dispatch` publishes this,
    /// so the bus, the delivery ledger and every sink see the same
    /// already-clean notice, whatever detector built the original.
    #[must_use]
    pub fn scrubbed(&self) -> Self {
        Self {
            label: self.label.as_deref().map(redact_text),
            summary: redact_text(&self.summary),
            detail: self.detail.as_deref().map(redact_text),
            subject_id: redact_text(&self.subject_id),
            payload: self.safe_payload(),
            ..self.clone()
        }
    }
}

/// The map without any secret-shaped key, at any depth.
fn strip_secret_keys(object: &Map<String, Value>) -> Map<String, Value> {
    object
        .iter()
        .filter(|(key, _)| !is_secret_shaped(key))
        .map(|(key, value)| (key.clone(), strip_value(value)))
        .collect()
}

fn strip_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(strip_secret_keys(object)),
        Value::Array(items) => Value::Array(items.iter().map(strip_value).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests;
