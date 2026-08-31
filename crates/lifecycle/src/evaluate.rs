//! Turning a subject plus its watermarks into the events it owes.
//!
//! This is the whole decision procedure, and it is pure: no clock, no
//! database, no network. The gateway's scanner supplies `now`, the persisted
//! watermarks, and the subjects; everything about *whether* a hook fires is
//! decided here, where it can be tested exhaustively.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::event::LifecycleEvent;
use crate::stage::{newly_crossed, ExpiryStage, Track, WATERMARK_UNFIRED};
use crate::subject::ExpirySubject;

/// How far up one track a subject has already been reported.
///
/// `expires_at` is part of the watermark on purpose: when a subject is
/// renewed its deadline moves, and the ladder must start over. Keying the
/// watermark on the deadline it was recorded against makes that reset
/// automatic instead of something a responder has to remember to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watermark {
    pub track: Track,
    /// The deadline this watermark was recorded against.
    pub expires_at: DateTime<Utc>,
    /// The stage last fired on this track.
    pub stage: ExpiryStage,
    /// That stage's threshold, in seconds remaining. Persisted rather than
    /// recomputed because a subject's `renew_before_seconds` can be edited
    /// between passes, and re-deriving it would move a rung that already
    /// fired.
    pub threshold_seconds: i64,
}

impl Watermark {
    /// The watermark to persist after `stage` fired for `subject`.
    #[must_use]
    pub fn after(subject: &ExpirySubject, stage: ExpiryStage) -> Self {
        Self {
            track: stage.track(),
            expires_at: subject.expires_at,
            stage,
            threshold_seconds: stage.threshold_seconds(subject.renew_before()),
        }
    }
}

/// Both watermarks for one subject, as loaded from storage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Watermarks {
    pub alert: Option<Watermark>,
    pub renewal: Option<Watermark>,
}

impl Watermarks {
    /// Build from whatever rows storage returned, ignoring any whose track
    /// does not match the slot it would occupy.
    #[must_use]
    pub fn from_rows(rows: impl IntoIterator<Item = Watermark>) -> Self {
        let mut marks = Self::default();
        for row in rows {
            match row.track {
                Track::Alert => marks.alert = Some(row),
                Track::Renewal => marks.renewal = Some(row),
            }
        }
        marks
    }

    #[must_use]
    fn for_track(self, track: Track) -> Option<Watermark> {
        match track {
            Track::Alert => self.alert,
            Track::Renewal => self.renewal,
        }
    }

    /// The comparison value for `track`. A watermark recorded against a
    /// different deadline is stale — the subject was renewed — so the ladder
    /// resets to unfired.
    #[must_use]
    fn effective(self, track: Track, subject: &ExpirySubject) -> i64 {
        match self.for_track(track) {
            Some(mark) if mark.expires_at == subject.expires_at => mark.threshold_seconds,
            _ => WATERMARK_UNFIRED,
        }
    }
}

/// The events `subject` owes at `now` — at most one per track, so zero to two.
///
/// Callers persist [`Watermark::after`] for each returned stage **after**
/// recording the event, so a crash between emit and record re-emits
/// (at-least-once) rather than drops (at-most-once) — the safe direction for
/// an expiry notice.
#[must_use]
pub fn evaluate(
    subject: &ExpirySubject,
    watermarks: Watermarks,
    now: DateTime<Utc>,
) -> Vec<LifecycleEvent> {
    let remaining = subject.remaining_seconds(now);
    let renew_before = subject.renew_before();
    Track::ALL
        .into_iter()
        .filter(|track| subject.alerting || *track != Track::Alert)
        .filter_map(|track| {
            let stage = newly_crossed(
                track,
                remaining,
                renew_before,
                watermarks.effective(track, subject),
            )?;
            Some(LifecycleEvent::for_stage(subject.clone(), stage, now))
        })
        .collect()
}

/// Whether the platform's own responder should act on this event.
///
/// Three conditions, all required: the event is a ladder rung rather than a
/// responder's own outcome, the rung is actionable, and the subject opted in.
///
/// The first condition is what stops a responder from feeding itself: an
/// outcome event keeps the stage that produced it, so without the check a
/// `lifecycle.renewal.succeeded` would look exactly as actionable as the
/// `lifecycle.renewal.due` that caused it, and every rotation would rotate
/// again. An alert-only subject still produces every event — subscribers are
/// always told — the platform just does not act on its behalf.
#[must_use]
pub fn should_respond(event: &LifecycleEvent) -> bool {
    // The kind is consulted first and independently of `auto_respond`: some
    // deadlines are never the platform's to extend on its own, and a subject
    // built with the wrong flag must not be able to make one so (ADR 0079).
    event.subject.kind.renewable()
        && event.is_ladder_event()
        && event.stage.is_actionable()
        && event.subject.auto_respond
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{
        EVENT_EXPIRY_EXPIRED, EVENT_EXPIRY_NOTICE, EVENT_EXPIRY_WARNING, EVENT_RENEWAL_DUE,
    };
    use crate::stage::{DEFAULT_RENEW_BEFORE_SECONDS, WARNING_SECONDS};
    use crate::subject::SubjectKind;

    fn at(raw: &str) -> DateTime<Utc> {
        raw.parse().unwrap()
    }

    fn subject(expires_at: &str, renew: Option<i64>, auto: bool) -> ExpirySubject {
        ExpirySubject {
            kind: SubjectKind::Certificate,
            subject_id: "cert-1".into(),
            organization_id: "org-1".into(),
            expires_at: at(expires_at),
            renew_before_seconds: renew,
            auto_respond: auto,
            alerting: true,
            label: None,
        }
    }

    /// Replay a subject hour by hour, recording watermarks as a caller would.
    fn replay(s: &ExpirySubject, from: &str, hours: i64) -> Vec<String> {
        let mut marks = Watermarks::default();
        let mut seen = Vec::new();
        let start = at(from);
        for hour in 0..hours {
            for event in evaluate(s, marks, start + chrono::Duration::hours(hour)) {
                seen.push(event.event_type.clone());
                let mark = Watermark::after(s, event.stage);
                match mark.track {
                    Track::Alert => marks.alert = Some(mark),
                    Track::Renewal => marks.renewal = Some(mark),
                }
            }
        }
        seen
    }

    #[test]
    fn a_distant_deadline_produces_nothing() {
        let s = subject("2027-08-30T00:00:00Z", None, true);
        assert!(evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:00Z")).is_empty());
    }

    #[test]
    fn crossing_the_first_rung_produces_a_notice() {
        let s = subject("2026-09-20T00:00:00Z", None, true);
        let events = evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:00Z"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EVENT_EXPIRY_NOTICE);
    }

    #[test]
    fn the_same_pass_repeated_is_silent() {
        let s = subject("2026-09-20T00:00:00Z", None, true);
        let now = at("2026-08-30T00:00:00Z");
        let event = evaluate(&s, Watermarks::default(), now).remove(0);
        let marks = Watermarks {
            alert: Some(Watermark::after(&s, event.stage)),
            renewal: None,
        };
        assert!(evaluate(&s, marks, now).is_empty());
        assert!(evaluate(&s, marks, at("2026-08-30T01:00:00Z")).is_empty());
    }

    #[test]
    fn the_default_renewal_lead_still_delivers_a_warning() {
        // The regression the two-track split exists for: with the default
        // 7-day lead the renewal rung aliases the warning rung, and a single
        // watermark suppressed `lifecycle.expiry.warning` forever.
        let s = subject("2026-09-30T00:00:00Z", Some(WARNING_SECONDS), true);
        let seen = replay(&s, "2026-08-01T00:00:00Z", 70 * 24);
        assert!(
            seen.iter().any(|t| t == EVENT_EXPIRY_WARNING),
            "warning must still fire: {seen:?}",
        );
        assert!(seen.iter().any(|t| t == EVENT_RENEWAL_DUE), "{seen:?}");
    }

    #[test]
    fn a_full_replay_fires_every_event_exactly_once() {
        for renew in [None, Some(3_600), Some(WARNING_SECONDS), Some(45 * 86_400)] {
            let s = subject("2026-09-30T00:00:00Z", renew, true);
            let mut seen = replay(&s, "2026-06-01T00:00:00Z", 130 * 24);
            let before = seen.len();
            seen.sort();
            seen.dedup();
            assert_eq!(before, seen.len(), "duplicate event at renew={renew:?}");
            assert_eq!(seen.len(), 5, "missing event at renew={renew:?}: {seen:?}");
        }
    }

    #[test]
    fn renewal_resets_both_ladders() {
        let old = subject("2026-09-20T00:00:00Z", None, true);
        let now = at("2026-08-30T00:00:00Z");
        let stale = Watermarks {
            alert: Some(Watermark::after(&old, ExpiryStage::Notice)),
            renewal: Some(Watermark::after(&old, ExpiryStage::Renewal)),
        };

        // The responder reissued: the deadline moved a year out, and the
        // stale watermarks must not suppress next year's ladder.
        let renewed = subject("2027-09-20T00:00:00Z", None, true);
        assert!(evaluate(&renewed, stale, now).is_empty());
        let events = evaluate(&renewed, stale, at("2027-09-01T00:00:00Z"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stage, ExpiryStage::Notice);
    }

    #[test]
    fn a_long_renewal_lead_fires_renewal_before_any_alert() {
        // 45-day lead on a 40-day-out certificate: the actionable rung fires
        // while the alert track is still quiet.
        let s = subject("2026-10-09T00:00:00Z", Some(45 * 86_400), true);
        let events = evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:00Z"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EVENT_RENEWAL_DUE);
        assert!(should_respond(&events[0]));
    }

    #[test]
    fn first_sight_of_an_expired_subject_reports_both_tracks_once() {
        let s = subject("2026-08-01T00:00:00Z", None, true);
        let now = at("2026-08-30T00:00:00Z");
        let events = evaluate(&s, Watermarks::default(), now);
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(types, [EVENT_EXPIRY_EXPIRED, EVENT_RENEWAL_DUE]);

        let marks = Watermarks::from_rows(events.iter().map(|e| Watermark::after(&s, e.stage)));
        assert!(evaluate(&s, marks, now).is_empty());
    }

    #[test]
    fn alert_only_subjects_still_emit_but_are_never_acted_on() {
        let s = subject("2026-08-01T00:00:00Z", None, false);
        let events = evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:00Z"));
        assert!(!events.is_empty());
        for event in &events {
            assert!(
                !should_respond(event),
                "auto_respond=false must never act: {}",
                event.event_type,
            );
        }
    }

    #[test]
    fn a_responder_outcome_never_triggers_another_responder() {
        // An outcome carries the stage that produced it, so without the
        // ladder-event check a succeeded rotation would look as actionable as
        // the renewal that caused it — and rotate forever.
        let s = subject("2026-08-01T00:00:00Z", None, true);
        let now = at("2026-08-30T00:00:00Z");
        for succeeded in [true, false] {
            let outcome = LifecycleEvent::for_outcome(
                s.clone(),
                ExpiryStage::Renewal,
                now,
                succeeded,
                Some("done"),
            );
            assert!(!outcome.is_ladder_event());
            assert!(!should_respond(&outcome), "succeeded={succeeded}");
        }
    }

    #[test]
    fn only_actionable_rungs_trigger_a_responder() {
        let s = subject("2026-09-20T00:00:00Z", None, true);
        let events = evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:00Z"));
        assert_eq!(events[0].stage, ExpiryStage::Notice);
        assert!(!should_respond(&events[0]));
    }

    #[test]
    fn a_schedule_subject_runs_the_renewal_track_and_stays_quiet() {
        // A rotation policy: its deadline moves on every rotation, which resets
        // the ladder, so narrating the alert rungs would mean re-firing
        // notice/warning/urgent on every single interval.
        let mut s = subject("2026-08-30T00:00:10Z", Some(1), true);
        s.alerting = false;
        let events = evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:20Z"));
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(types, [EVENT_RENEWAL_DUE]);
        assert!(should_respond(&events[0]));
    }

    #[test]
    fn a_schedule_subject_is_silent_before_it_comes_due() {
        let mut s = subject("2026-08-30T01:00:00Z", Some(1), true);
        s.alerting = false;
        // Well inside every alert threshold, but not yet due.
        assert!(evaluate(&s, Watermarks::default(), at("2026-08-30T00:00:00Z")).is_empty());
    }

    #[test]
    fn a_schedule_subject_re_fires_after_each_reschedule() {
        let mut first = subject("2026-08-30T01:00:00Z", Some(1), true);
        first.alerting = false;
        let due = at("2026-08-30T01:00:00Z");
        let events = evaluate(&first, Watermarks::default(), due);
        assert_eq!(events.len(), 1);
        let marks = Watermarks::from_rows([Watermark::after(&first, events[0].stage)]);
        assert!(evaluate(&first, marks, due).is_empty(), "no double-fire");

        // The responder rotated and the schedule advanced an hour: the stale
        // watermark must not suppress the next run.
        let mut next = first.clone();
        next.expires_at = at("2026-08-30T02:00:00Z");
        assert!(evaluate(&next, marks, due).is_empty());
        assert_eq!(
            evaluate(&next, marks, at("2026-08-30T02:00:00Z")).len(),
            1,
            "the next interval must come due again",
        );
    }

    #[test]
    fn watermark_rows_land_in_their_own_track_slots() {
        let s = subject("2026-09-20T00:00:00Z", None, true);
        let marks = Watermarks::from_rows([
            Watermark::after(&s, ExpiryStage::Renewal),
            Watermark::after(&s, ExpiryStage::Urgent),
        ]);
        assert_eq!(marks.alert.map(|m| m.stage), Some(ExpiryStage::Urgent));
        assert_eq!(marks.renewal.map(|m| m.stage), Some(ExpiryStage::Renewal));
        let _ = DEFAULT_RENEW_BEFORE_SECONDS;
    }
}

#[cfg(test)]
mod never_renewable_tests {
    use super::*;
    use crate::subject::SubjectKind;

    fn at(raw: &str) -> DateTime<Utc> {
        raw.parse().unwrap()
    }

    fn grant_subject(auto_respond: bool) -> ExpirySubject {
        ExpirySubject {
            kind: SubjectKind::SessionGrant,
            subject_id: "sgrant-1".into(),
            organization_id: "org-1".into(),
            expires_at: at("2026-09-01T00:00:00Z"),
            renew_before_seconds: None,
            auto_respond,
            alerting: true,
            label: None,
        }
    }

    #[test]
    fn a_session_grant_is_never_auto_renewed_even_when_the_flag_says_so() {
        // The point of putting renewability on the kind: a subject built with
        // `auto_respond: true` — by mistake, or by copying a row from a
        // certificate — must still not cause the platform to extend one
        // human's reach into another's vault (ADR 0079).
        let subject = grant_subject(true);
        let now = at("2026-08-31T00:00:00Z");
        let events = evaluate(&subject, Watermarks::default(), now);

        assert!(!events.is_empty(), "the ladder still narrates");
        for event in &events {
            assert!(
                !should_respond(event),
                "{} must never be acted on automatically",
                event.event_type
            );
        }
    }

    #[test]
    fn a_session_grant_still_warns_on_every_rung_it_crosses() {
        // Refusing to act is not refusing to tell. Somebody whose access
        // lapses in an hour is exactly who the ladder exists for.
        let subject = grant_subject(false);
        let now = at("2026-08-31T23:30:00Z");
        let events = evaluate(&subject, Watermarks::default(), now);
        assert!(
            events.iter().any(LifecycleEvent::is_ladder_event),
            "expected at least one ladder event, got {events:?}"
        );
    }

    #[test]
    fn a_renewable_kind_is_unaffected_by_the_new_rule() {
        // The regression that would matter: certificates must still renew.
        let mut subject = grant_subject(true);
        subject.kind = SubjectKind::Certificate;
        subject.subject_id = "cert-1".into();
        let now = at("2026-08-31T23:30:00Z");
        let events = evaluate(&subject, Watermarks::default(), now);
        assert!(
            events.iter().any(should_respond),
            "a certificate on an actionable rung should still be acted on"
        );
    }
}
