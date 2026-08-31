//! Projecting a lifecycle event onto the shared security-event envelope.
//!
//! This is the seam that makes expiry and breach one pattern rather than two.
//! The lifecycle plane keeps its own vocabulary — stages, tracks, watermarks,
//! because those are real and specific to deadlines — and hands the notifier,
//! the alerter, and every industry-standard sink a
//! [`SecurityNotice`](opensesame_security_events::SecurityNotice) that looks
//! exactly like the one a breach finding produces. Neither of them knows the
//! other exists.
//!
//! Two mappings carry the judgement, and both are the interesting part:
//!
//! - **Severity.** A rung is not automatically loud. Something expiring in
//!   thirty days is information; something that has already expired is
//!   critical, because authority has lapsed and whatever depended on it is
//!   failing now.
//! - **State.** A successful renewal *resolves*. Without that, an on-call
//!   rotation accumulates pages for certificates that were reissued hours ago,
//!   learns the feed is noise, and stops reading it.

use opensesame_security_events::{NoticeState, SecurityNotice, Severity};

use crate::event::{LifecycleEvent, EVENT_RENEWAL_FAILED, EVENT_RENEWAL_SUCCEEDED};
use crate::stage::ExpiryStage;

/// How loud each rung of the ladder is.
///
/// `Renewal` is only a `Warning` even though it is the actionable rung: the
/// platform's own responder is about to act on it, and paging a human for
/// something being handled automatically is how alert fatigue starts. It is
/// the *failure* of that renewal that escalates.
#[must_use]
pub const fn severity_for_stage(stage: ExpiryStage) -> Severity {
    match stage {
        ExpiryStage::Notice => Severity::Info,
        ExpiryStage::Warning | ExpiryStage::Renewal => Severity::Warning,
        ExpiryStage::Urgent => Severity::Error,
        ExpiryStage::Expired => Severity::Critical,
    }
}

/// A rough, human-facing rendering of a duration.
///
/// Deliberately coarse: the exact second is in `remaining_seconds` on the
/// payload, and a summary line reading "expires in 6 days" is more useful to
/// somebody reading a page at 3am than one reading "in 518,417 seconds".
#[must_use]
pub fn humanize_seconds(seconds: i64) -> String {
    let magnitude = seconds.unsigned_abs();
    let (count, unit) = match magnitude {
        0..=90 => (magnitude, "second"),
        91..=5_400 => (magnitude / 60, "minute"),
        5_401..=172_800 => (magnitude / 3_600, "hour"),
        _ => (magnitude / 86_400, "day"),
    };
    let plural = if count == 1 { "" } else { "s" };
    format!("{count} {unit}{plural}")
}

impl LifecycleEvent {
    /// The severity this event carries onto the shared feed.
    ///
    /// An outcome event overrides its rung's severity: a renewal that failed
    /// is an `Error` regardless of how far off the deadline still is, because
    /// the automation that was going to handle it did not.
    #[must_use]
    pub fn severity(&self) -> Severity {
        match self.event_type.as_str() {
            EVENT_RENEWAL_SUCCEEDED => Severity::Info,
            EVENT_RENEWAL_FAILED => Severity::Error,
            _ => severity_for_stage(self.stage),
        }
    }

    /// Whether this event settles a condition rather than raising one.
    #[must_use]
    pub fn is_resolution(&self) -> bool {
        self.event_type == EVENT_RENEWAL_SUCCEEDED
    }

    /// One line a human reads first.
    #[must_use]
    pub fn summary(&self) -> String {
        let name = self
            .subject
            .label
            .as_deref()
            .unwrap_or(&self.subject.subject_id);
        let kind = self.subject.kind.as_str();
        match self.event_type.as_str() {
            EVENT_RENEWAL_SUCCEEDED => format!("{kind} {name} was renewed"),
            EVENT_RENEWAL_FAILED => format!("{kind} {name} could not be renewed automatically"),
            _ => self.deadline_summary(kind, name),
        }
    }

    /// The summary for a ladder rung, which is always about a deadline.
    fn deadline_summary(&self, kind: &str, name: &str) -> String {
        let elapsed = humanize_seconds(self.remaining_seconds);
        match self.stage {
            ExpiryStage::Expired => format!("{kind} {name} expired {elapsed} ago"),
            ExpiryStage::Renewal => {
                format!("{kind} {name} is due for renewal; it expires in {elapsed}")
            }
            _ => format!("{kind} {name} expires in {elapsed}"),
        }
    }

    /// The normalized envelope the notifier, the alerter, and every sink read.
    #[must_use]
    pub fn notice(&self) -> SecurityNotice {
        SecurityNotice {
            event_type: self.event_type.clone(),
            severity: self.severity(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subject::{ExpirySubject, SubjectKind};
    use chrono::{DateTime, Utc};

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
    fn the_ladder_gets_louder_as_the_deadline_closes() {
        assert!(severity_for_stage(ExpiryStage::Notice) < severity_for_stage(ExpiryStage::Urgent));
        assert!(severity_for_stage(ExpiryStage::Urgent) < severity_for_stage(ExpiryStage::Expired));
        assert_eq!(severity_for_stage(ExpiryStage::Expired), Severity::Critical);
    }

    #[test]
    fn an_automated_renewal_does_not_page_but_its_failure_does() {
        let due = LifecycleEvent::for_stage(subject(), ExpiryStage::Renewal, now());
        assert_eq!(due.severity(), Severity::Warning);

        let failed = LifecycleEvent::for_outcome(
            subject(),
            ExpiryStage::Renewal,
            now(),
            false,
            Some("provider refused"),
        );
        assert_eq!(failed.severity(), Severity::Error);
    }

    #[test]
    fn a_successful_renewal_resolves_the_alert_the_deadline_opened() {
        let urgent = LifecycleEvent::for_stage(subject(), ExpiryStage::Urgent, now()).notice();
        let renewed =
            LifecycleEvent::for_outcome(subject(), ExpiryStage::Renewal, now(), true, None)
                .notice();
        assert_eq!(renewed.state, NoticeState::Resolved);
        assert_eq!(urgent.state, NoticeState::Firing);
        assert_eq!(
            urgent.alert_key(),
            renewed.alert_key(),
            "the renewal must close the page the deadline opened",
        );
    }

    #[test]
    fn a_failed_renewal_keeps_the_alert_open() {
        let failed =
            LifecycleEvent::for_outcome(subject(), ExpiryStage::Renewal, now(), false, None);
        assert_eq!(failed.notice().state, NoticeState::Firing);
    }

    #[test]
    fn durations_read_the_way_a_human_would_say_them() {
        assert_eq!(humanize_seconds(30), "30 seconds");
        assert_eq!(humanize_seconds(1), "1 second");
        assert_eq!(humanize_seconds(600), "10 minutes");
        assert_eq!(humanize_seconds(64_800), "18 hours");
        assert_eq!(humanize_seconds(7 * 86_400), "7 days");
        // Hours run to two days on purpose: the urgent rung is a 24-hour
        // deadline, and "in 24 hours" is a sharper thing to read on a page
        // than "in 1 day".
        assert_eq!(humanize_seconds(86_400), "24 hours");
        assert_eq!(humanize_seconds(2 * 86_400 + 1), "2 days");
    }

    #[test]
    fn an_elapsed_deadline_reads_as_time_since_rather_than_a_negative() {
        let mut expired = LifecycleEvent::for_stage(subject(), ExpiryStage::Expired, now());
        expired.remaining_seconds = -172_801;
        let summary = expired.summary();
        assert!(summary.contains("expired"), "{summary}");
        assert!(summary.ends_with("ago"), "{summary}");
        assert!(!summary.contains('-'), "{summary}");
    }

    #[test]
    fn the_notice_carries_the_events_own_payload() {
        let event = LifecycleEvent::for_stage(subject(), ExpiryStage::Urgent, now());
        let notice = event.notice();
        assert_eq!(notice.payload, event.payload());
        assert_eq!(notice.subject_kind, "certificate");
        assert_eq!(notice.label.as_deref(), Some("api.example.com"));
        assert!(notice.summary.contains("api.example.com"));
    }

    #[test]
    fn a_subject_without_a_label_is_named_by_its_id() {
        let mut anonymous = subject();
        anonymous.label = None;
        let event = LifecycleEvent::for_stage(anonymous, ExpiryStage::Warning, now());
        assert!(event.summary().contains("cert-1"));
    }

    #[test]
    fn every_stage_and_outcome_produces_a_non_empty_summary() {
        for stage in ExpiryStage::ALL {
            let rung = LifecycleEvent::for_stage(subject(), stage, now());
            assert!(!rung.summary().is_empty(), "{stage:?}");
            for succeeded in [true, false] {
                let outcome = LifecycleEvent::for_outcome(subject(), stage, now(), succeeded, None);
                assert!(!outcome.summary().is_empty(), "{stage:?}/{succeeded}");
            }
        }
    }
}
