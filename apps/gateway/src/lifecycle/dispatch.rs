//! Fan-out: one lifecycle event to the bus, to every matching subscriber, and
//! — when the platform owns a responder for it — to that responder.
//!
//! The ordering is deliberate. Subscribers are enqueued **before** the
//! responder runs, so a tool watching `lifecycle.renewal.due` learns about the
//! renewal whether or not our own rotation then succeeds. A responder that
//! panicked or hung must not be able to swallow the notification.

use chrono::{DateTime, Utc};
use opensesame_lifecycle::{
    filter_matches, should_respond, LifecycleEvent, Watermark, MAX_DETAIL_CHARS,
};
use opensesame_storage::{StoredLifecycleDelivery, StoredLifecycleHook, StoredLifecycleWatermark};
use opensesame_task_bus::BusEvent;

use crate::app_state::AppState;
use crate::lifecycle::responders;

const BUS_SOURCE: &str = "opensesame://gateway/lifecycle";

/// Publish one ladder event and settle everything it implies.
///
/// Returns the outcome event a responder produced, if one ran, so a caller can
/// report it. Every step is best-effort and logged rather than fatal: a
/// scanner pass must keep going when one subscriber's row is unwritable.
pub async fn publish(state: &AppState, event: &LifecycleEvent, now: DateTime<Utc>) {
    publish_to_bus(state, event).await;
    enqueue_for_subscribers(state, event, now).await;
    record_watermark(state, event, now).await;

    if !should_respond(event) {
        return;
    }
    let outcome = responders::respond(state, event).await;
    let detail: String = outcome.detail.chars().take(MAX_DETAIL_CHARS).collect();
    if outcome.succeeded {
        tracing::info!(
            event_type = %event.event_type,
            subject_kind = event.subject.kind.as_str(),
            subject_id = %event.subject.subject_id,
            detail = %detail,
            "lifecycle responder acted",
        );
    } else {
        tracing::warn!(
            event_type = %event.event_type,
            subject_kind = event.subject.kind.as_str(),
            subject_id = %event.subject.subject_id,
            detail = %detail,
            "lifecycle responder could not act",
        );
    }

    // The outcome is itself a subscribable event: a tool that wants to take
    // over when our rotation fails needs to hear that it failed. It is never
    // fed back to a responder — `should_respond` refuses outcome events.
    let outcome_event = LifecycleEvent::for_outcome(
        event.subject.clone(),
        event.stage,
        now,
        outcome.succeeded,
        Some(&detail),
    );
    publish_to_bus(state, &outcome_event).await;
    enqueue_for_subscribers(state, &outcome_event, now).await;
}

/// Publish on the `TaskBus`. The bus accelerates and observes; the delivery
/// ledger is the source of truth, so a bus outage never loses a hook.
async fn publish_to_bus(state: &AppState, event: &LifecycleEvent) {
    let bus_event = BusEvent::cloud_event(
        uuid::Uuid::now_v7().to_string(),
        BUS_SOURCE,
        event.event_type.clone(),
        event.occurred_at.to_rfc3339(),
        event.payload(),
    );
    let bus = state.task_bus.read().await;
    if let Err(error) = bus.publish(bus_event).await {
        tracing::warn!(
            %error,
            event_type = %event.event_type,
            "lifecycle TaskBus publish failed; the delivery ledger still carries it",
        );
    }
}

/// Whether a stored subscription selects this event.
///
/// Both filters must pass, and an empty event filter matches nothing: a hook
/// that names no events is a misconfiguration, and defaulting it to
/// "everything" is the wrong direction to fail.
#[must_use]
pub fn hook_matches(hook: &StoredLifecycleHook, event: &LifecycleEvent) -> bool {
    if !hook.enabled {
        return false;
    }
    if !filter_matches(&hook.event_types, &event.event_type) {
        return false;
    }
    match &hook.subject_kinds {
        None => true,
        Some(kinds) => kinds.iter().any(|kind| kind == event.subject.kind.as_str()),
    }
}

async fn enqueue_for_subscribers(state: &AppState, event: &LifecycleEvent, now: DateTime<Utc>) {
    let hooks = match state
        .db
        .list_lifecycle_hooks(&event.subject.organization_id)
        .await
    {
        Ok(hooks) => hooks,
        Err(error) => {
            tracing::warn!(%error, "lifecycle fan-out could not read subscriptions");
            return;
        }
    };
    let payload = match serde_json::to_string(&event.payload()) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(%error, "lifecycle payload could not be encoded");
            return;
        }
    };
    for hook in hooks {
        // Internal hook rows are documentation of a platform responder, not a
        // delivery target: the responder runs in-process, so queueing an
        // outbound delivery for it would be a row nobody ever drains.
        if hook.delivery != "webhook" || !hook_matches(&hook, event) {
            continue;
        }
        let delivery = StoredLifecycleDelivery {
            id: format!("lcd_{}", uuid::Uuid::now_v7()),
            organization_id: hook.organization_id.clone(),
            hook_id: hook.id.clone(),
            event_type: event.event_type.clone(),
            subject_kind: event.subject.kind.as_str().to_string(),
            subject_id: event.subject.subject_id.clone(),
            payload_json: payload.clone(),
            state: "pending".into(),
            attempts: 0,
            available_at: None,
            last_error: None,
            delivered_at: None,
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        };
        if let Err(error) = state.db.enqueue_lifecycle_delivery(&delivery).await {
            tracing::warn!(%error, hook_id = %hook.id, "lifecycle delivery could not be queued");
        }
    }
}

/// Advance the fired rung's watermark.
///
/// Recorded *after* the event has been queued, never before: a crash in
/// between re-emits on the next pass, which is at-least-once. For an expiry
/// notice that is the safe direction — a duplicate warning is noise, a dropped
/// one is an outage.
async fn record_watermark(state: &AppState, event: &LifecycleEvent, now: DateTime<Utc>) {
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
    if let Err(error) = state.db.record_lifecycle_watermark(&row, now).await {
        tracing::warn!(
            %error,
            subject_id = %event.subject.subject_id,
            "lifecycle watermark could not be recorded; the rung will re-fire",
        );
    }
}

/// Current wall clock, isolated so tests can pin it.
#[must_use]
pub fn now() -> DateTime<Utc> {
    Utc::now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_lifecycle::{ExpirySubject, ExpiryStage, SubjectKind, EVENT_RENEWAL_DUE};

    fn hook(event_types: &[&str], kinds: Option<&[&str]>) -> StoredLifecycleHook {
        StoredLifecycleHook {
            id: "hook:1".into(),
            organization_id: "org:1".into(),
            name: "expiry".into(),
            event_types: event_types.iter().map(|s| (*s).to_string()).collect(),
            delivery: "webhook".into(),
            endpoint_url: Some("https://hooks.example/expiry".into()),
            responder: None,
            subject_kinds: kinds.map(|k| k.iter().map(|s| (*s).to_string()).collect()),
            enabled: true,
            sealed_secret: None,
            last_delivered_at: None,
            last_error: None,
            version: 1,
            created_at: "2026-08-30T00:00:00+00:00".into(),
            updated_at: "2026-08-30T00:00:00+00:00".into(),
        }
    }

    fn event(kind: SubjectKind) -> LifecycleEvent {
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
            ExpiryStage::Renewal,
            "2026-09-05T00:00:00Z".parse().unwrap(),
        )
    }

    #[test]
    fn an_exact_event_filter_matches_only_that_event() {
        let subscription = hook(&[EVENT_RENEWAL_DUE], None);
        assert!(hook_matches(&subscription, &event(SubjectKind::Certificate)));

        let other = LifecycleEvent::for_stage(
            event(SubjectKind::Certificate).subject,
            ExpiryStage::Notice,
            "2026-09-05T00:00:00Z".parse().unwrap(),
        );
        assert!(!hook_matches(&subscription, &other));
    }

    #[test]
    fn a_wildcard_filter_matches_every_lifecycle_event() {
        let subscription = hook(&["lifecycle.*"], None);
        for stage in ExpiryStage::ALL {
            let any = LifecycleEvent::for_stage(
                event(SubjectKind::Certificate).subject,
                stage,
                "2026-09-05T00:00:00Z".parse().unwrap(),
            );
            assert!(hook_matches(&subscription, &any), "{stage:?}");
        }
    }

    #[test]
    fn a_subject_kind_filter_narrows_further() {
        let subscription = hook(&["lifecycle.*"], Some(&["certificate"]));
        assert!(hook_matches(&subscription, &event(SubjectKind::Certificate)));
        assert!(!hook_matches(&subscription, &event(SubjectKind::StorePath)));

        let unfiltered = hook(&["lifecycle.*"], None);
        assert!(hook_matches(&unfiltered, &event(SubjectKind::StorePath)));
    }

    #[test]
    fn a_disabled_hook_matches_nothing() {
        let mut subscription = hook(&["lifecycle.*"], None);
        subscription.enabled = false;
        assert!(!hook_matches(&subscription, &event(SubjectKind::Certificate)));
    }

    #[test]
    fn a_hook_naming_no_events_matches_nothing() {
        let subscription = hook(&[], None);
        assert!(
            !hook_matches(&subscription, &event(SubjectKind::Certificate)),
            "an empty filter must not be read as 'everything'",
        );
    }
}
