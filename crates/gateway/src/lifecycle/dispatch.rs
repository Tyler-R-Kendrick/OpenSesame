//! Expiry's entry onto the security-event feed.
//!
//! Everything about *who receives this and how* now lives in
//! [`crate::security::dispatch`], shared with every other detector. What is
//! left here is the part that is genuinely about deadlines: claiming the rung
//! so it fires exactly once, and running the platform's own renewal responder.
//!
//! The ordering is deliberate. Subscribers are notified **before** the
//! responder runs, so a tool watching `lifecycle.renewal.due` learns about the
//! renewal whether or not our own rotation then succeeds. A responder that
//! panicked or hung must not be able to swallow the notification.

use chrono::DateTime;
use chrono::Utc;
use opensesame_lifecycle::{
    should_respond, LifecycleEvent, SubjectKind, Watermark, MAX_DETAIL_CHARS,
};
use opensesame_storage::StoredLifecycleWatermark;

use crate::app_state::AppState;
use crate::lifecycle::responders::{self, Outcome};
use crate::security;

/// Publish one ladder event and settle everything it implies.
///
/// Every step is best-effort and logged rather than fatal: a scanner pass must
/// keep going when one subscriber's row is unwritable.
pub async fn publish(state: &AppState, event: &LifecycleEvent, now: DateTime<Utc>) {
    security::dispatch::publish(state, &event.notice(), now).await;

    // The watermark write is the claim, and only the winner may act.
    //
    // Publishing stays at-least-once on purpose: a crash between emit and
    // record re-notifies rather than drops, which is the safe direction for an
    // expiry notice, and subscribers are built for duplicates. *Acting* is the
    // opposite — reissuing a certificate or rotating a credential twice is a
    // real fault, and two gateway processes scanning concurrently both see an
    // unrecorded rung. So the claim gates the responder and nothing else
    // (ADR 0076).
    let claimed = record_watermark(state, event, now).await;

    if !claimed || !should_respond(event) {
        return;
    }
    let outcome = respond_or_start(state, event).await;
    settle_outcome(state, event, &outcome, now).await;
}

/// The scanner's entry to the platform responder.
///
/// A web login is a run of up to 15 minutes, every step waiting on a person's
/// browser, so it is *started* as a tracked task and the scanner moves on;
/// every other kind is an act of moments and is done inline.
async fn respond_or_start(state: &AppState, event: &LifecycleEvent) -> Outcome {
    if event.subject.kind == SubjectKind::WebLogin {
        return crate::web_login::start(state, event).await;
    }
    responders::respond(state, event).await
}

/// Log a responder's outcome and publish it as a subscribable event.
///
/// A run that was only *started* has no outcome yet, so nothing is published
/// for it here: the run calls this itself when it ends. Publishing "success"
/// for a run that has begun would resolve the alert an approaching deadline
/// opened before anything was fixed.
pub(crate) async fn settle_outcome(
    state: &AppState,
    event: &LifecycleEvent,
    outcome: &Outcome,
    now: DateTime<Utc>,
) {
    let detail: String = outcome.detail.chars().take(MAX_DETAIL_CHARS).collect();
    log_outcome(event, outcome, &detail);
    if outcome.pending {
        return;
    }

    // The outcome is itself a subscribable event: a tool that wants to take
    // over when our rotation fails needs to hear that it failed. It is never
    // fed back to a responder — `should_respond` refuses outcome events.
    //
    // A success also *resolves* on the shared feed, so the page an approaching
    // deadline opened is closed by the renewal that fixed it.
    let outcome_event = LifecycleEvent::for_outcome(
        event.subject.clone(),
        event.stage,
        now,
        outcome.succeeded,
        Some(&detail),
    );
    security::dispatch::publish(state, &outcome_event.notice(), now).await;
}

fn log_outcome(event: &LifecycleEvent, outcome: &Outcome, detail: &str) {
    if outcome.succeeded {
        tracing::info!(
            event_type = %event.event_type,
            subject_kind = event.subject.kind.as_str(),
            subject_id = %event.subject.subject_id,
            pending = outcome.pending,
            detail,
            "lifecycle responder acted",
        );
    } else {
        tracing::warn!(
            event_type = %event.event_type,
            subject_kind = event.subject.kind.as_str(),
            subject_id = %event.subject.subject_id,
            detail,
            "lifecycle responder could not act",
        );
    }
}

/// Claim this rung. `true` means this process advanced the watermark and may
/// act on the subject.
///
/// Recorded *after* the event has been published, never before: a crash in
/// between re-emits on the next pass, which is at-least-once. For an expiry
/// notice that is the safe direction — a duplicate warning is noise, a dropped
/// one is an outage.
async fn record_watermark(state: &AppState, event: &LifecycleEvent, now: DateTime<Utc>) -> bool {
    let mark = Watermark::after(&event.subject, event.stage);
    let row = StoredLifecycleWatermark {
        organization_id: event.subject.organization_id.clone(),
        subject_kind: event.subject.kind.as_str().to_string(),
        subject_id: event.subject.subject_id.clone(),
        track: mark.track.as_str().to_string(),
        stage: mark.stage.as_str().to_string(),
        threshold_seconds: mark.threshold_seconds,
        expires_at: mark.expires_at.to_rfc3339(),
    };
    match state.db.record_lifecycle_watermark(&row, now).await {
        Ok(claimed) => claimed,
        Err(error) => {
            // Fail closed. Without a recorded claim we cannot show that nobody
            // else is already acting, and standing down costs a delayed
            // rotation where acting anyway risks doing it twice.
            tracing::warn!(
                %error,
                subject_id = %event.subject.subject_id,
                "lifecycle watermark could not be recorded; standing down, the rung will re-fire",
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_lifecycle::{ExpiryStage, ExpirySubject, SubjectKind};
    use opensesame_security_events::{NoticeState, Severity};

    fn now() -> DateTime<Utc> {
        "2026-09-05T00:00:00Z".parse().unwrap()
    }

    fn event(kind: SubjectKind, stage: ExpiryStage) -> LifecycleEvent {
        LifecycleEvent::for_stage(
            ExpirySubject {
                kind,
                subject_id: "target:1".into(),
                organization_id: "org:1".into(),
                expires_at: "2026-09-06T00:00:00Z".parse().unwrap(),
                renew_before_seconds: Some(86_400),
                auto_respond: true,
                alerting: true,
                label: None,
            },
            stage,
            now(),
        )
    }

    #[test]
    fn a_rung_reaches_the_shared_feed_as_a_notice() {
        let notice = event(SubjectKind::Certificate, ExpiryStage::Urgent).notice();
        assert_eq!(notice.event_type, "lifecycle.expiry.urgent");
        assert_eq!(notice.organization_id, "org:1");
        assert_eq!(notice.subject_kind, "certificate");
        assert_eq!(notice.severity, Severity::Error);
        assert_eq!(notice.state, NoticeState::Firing);
    }

    #[test]
    fn a_successful_outcome_resolves_the_alert_its_rung_opened() {
        let rung = event(SubjectKind::Certificate, ExpiryStage::Renewal);
        let renewed = LifecycleEvent::for_outcome(
            rung.subject.clone(),
            rung.stage,
            now(),
            true,
            Some("reissued"),
        );
        assert_eq!(renewed.notice().state, NoticeState::Resolved);
        assert_eq!(rung.notice().alert_key(), renewed.notice().alert_key());
    }

    #[test]
    fn a_failed_outcome_is_never_fed_back_to_a_responder() {
        let failed = LifecycleEvent::for_outcome(
            event(SubjectKind::StorePath, ExpiryStage::Renewal).subject,
            ExpiryStage::Renewal,
            now(),
            false,
            None,
        );
        assert!(
            !should_respond(&failed),
            "an outcome must not look as actionable as the rung that caused it",
        );
        assert_eq!(failed.notice().severity, Severity::Error);
    }

    #[test]
    fn a_watermark_row_mirrors_the_rung_that_produced_it() {
        let rung = event(SubjectKind::Certificate, ExpiryStage::Renewal);
        let mark = Watermark::after(&rung.subject, rung.stage);
        assert_eq!(mark.stage.as_str(), "renewal");
        assert_eq!(mark.track.as_str(), "renewal");
        assert_eq!(mark.expires_at, rung.subject.expires_at);
    }
}
