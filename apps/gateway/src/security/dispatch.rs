//! Fan-out: one security event to the bus, to every matching subscriber, and
//! to the two subscribers that are always there.
//!
//! Every detector publishes through here. Expiry did first and still does; the
//! breach scanner joined without teaching this module anything about breaches,
//! which is the property that makes the next detector cheap and the one after
//! that safe. Nothing in this file names a family.
//!
//! Delivery is at-least-once by design: a subscriber's ledger row is written
//! before anything else acts, so a crash re-notifies rather than drops. For a
//! security event that is the safe direction — a duplicate warning is noise, a
//! dropped one is an outage — and every sink here deduplicates on the notice's
//! alert key anyway.

use chrono::{DateTime, Utc};
use opensesame_security_events::SecurityNotice;
use opensesame_storage::{StoredSecurityDelivery, StoredSecurityHook};
use opensesame_task_bus::BusEvent;

use crate::app_state::AppState;
use crate::security::{alert, hooks, notify};

const BUS_SOURCE: &str = "opensesame://gateway/security";

/// Publish one security event and settle everything it implies.
///
/// Every step is best-effort and logged rather than fatal: a scan pass must
/// keep going when one subscriber's row is unwritable.
pub async fn publish(state: &AppState, notice: &SecurityNotice, now: DateTime<Utc>) {
    publish_to_bus(state, notice).await;
    let subscriptions = subscriptions(state, &notice.organization_id).await;
    enqueue_for_subscribers(state, notice, &subscriptions, now).await;
    run_builtin_subscribers(notice, &subscriptions);
}

/// The subscriptions for an organization, falling back to the built-in pair
/// when the table cannot be read.
///
/// The fallback is the point. If the hook table is unreadable — a corrupt row,
/// a migration half-applied, a disk problem — the thing we must not do is stop
/// telling anyone that a credential is exposed. Outbound subscribers are lost
/// in that state because we genuinely do not know who they are; the built-in
/// notifier and alerter are not, because they need no configuration to work.
async fn subscriptions(state: &AppState, organization_id: &str) -> Vec<StoredSecurityHook> {
    match state.db.list_security_hooks(organization_id).await {
        Ok(found) => found,
        Err(error) => {
            tracing::warn!(
                %error,
                "security fan-out could not read subscriptions; falling back to the built-in pair",
            );
            hooks::default_hooks(organization_id, Utc::now())
        }
    }
}

/// Run the subscribers the platform ships with.
///
/// In process and synchronous, because both of them write to this process's own
/// log stream and there is nothing to retry. Community subscriptions are
/// observers delivered asynchronously and cannot influence any decision
/// (ADR 0065 §7); these two do not make decisions either, they only record.
fn run_builtin_subscribers(notice: &SecurityNotice, subscriptions: &[StoredSecurityHook]) {
    if hooks::builtin_selects(subscriptions, hooks::NOTIFY_RESPONDER, notice) {
        notify::record(notice);
    }
    if alert::selects(subscriptions, notice) {
        alert::raise(notice, &hooks::alert_sinks(subscriptions, notice));
    }
}

/// Publish on the `TaskBus`. The bus accelerates and observes; the delivery
/// ledger is the source of truth, so a bus outage never loses a hook.
async fn publish_to_bus(state: &AppState, notice: &SecurityNotice) {
    let bus_event = BusEvent::cloud_event(
        uuid::Uuid::now_v7().to_string(),
        BUS_SOURCE,
        notice.event_type.clone(),
        notice.occurred_at.to_rfc3339(),
        notice.safe_payload(),
    );
    let bus = state.task_bus.read().await;
    if let Err(error) = bus.publish(bus_event).await {
        tracing::warn!(
            %error,
            event_type = %notice.event_type,
            "security TaskBus publish failed; the delivery ledger still carries it",
        );
    }
}

/// One queued delivery of `notice` to `hook`.
fn pending_delivery(
    hook: &StoredSecurityHook,
    notice: &SecurityNotice,
    payload_json: String,
    now: DateTime<Utc>,
) -> StoredSecurityDelivery {
    StoredSecurityDelivery {
        id: format!("secd_{}", uuid::Uuid::now_v7()),
        organization_id: hook.organization_id.clone(),
        hook_id: hook.id.clone(),
        event_type: notice.event_type.clone(),
        subject_kind: notice.subject_kind.clone(),
        subject_id: notice.subject_id.clone(),
        payload_json,
        state: "pending".into(),
        attempts: 0,
        available_at: None,
        last_error: None,
        delivered_at: None,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    }
}

/// Queue an outbound delivery for every subscription that wants one.
///
/// The stored payload is the *notice*, not the detector's raw event: it is what
/// every sink renders from, and storing it means a delivery replayed from the
/// ledger produces the same body as the one that failed.
async fn enqueue_for_subscribers(
    state: &AppState,
    notice: &SecurityNotice,
    subscriptions: &[StoredSecurityHook],
    now: DateTime<Utc>,
) {
    let payload = match serde_json::to_string(notice) {
        Ok(encoded) => encoded,
        Err(error) => {
            tracing::warn!(%error, "security notice could not be encoded for delivery");
            return;
        }
    };
    for hook in subscriptions
        .iter()
        .filter(|hook| hooks::wants_delivery(hook, notice))
    {
        let delivery = pending_delivery(hook, notice, payload.clone(), now);
        if let Err(error) = state.db.enqueue_security_delivery(&delivery).await {
            tracing::warn!(%error, hook_id = %hook.id, "security delivery could not be queued");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_security_events::{Delivery, NoticeState, Severity};
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        "2026-08-30T00:00:00Z".parse().unwrap()
    }

    fn notice() -> SecurityNotice {
        SecurityNotice {
            event_type: "breach.password.compromised".into(),
            severity: Severity::Critical,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "store_path".into(),
            subject_id: "Dev/api-token".into(),
            label: None,
            occurred_at: now(),
            summary: "a stored secret appears in a public breach corpus".into(),
            detail: None,
            payload: json!({"occurrences": 42, "password": "hunter2"}),
        }
    }

    fn hook(delivery: Delivery) -> StoredSecurityHook {
        StoredSecurityHook {
            id: "hook:1".into(),
            organization_id: "org-1".into(),
            name: "sink".into(),
            event_types: vec!["*".into()],
            delivery: delivery.as_str().into(),
            endpoint_url: Some("https://sink.example/in".into()),
            responder: None,
            subject_kinds: None,
            severity_min: "info".into(),
            enabled: true,
            sealed_secret: None,
            last_delivered_at: None,
            last_error: None,
            version: 1,
            created_at: now().to_rfc3339(),
            updated_at: now().to_rfc3339(),
        }
    }

    /// A blocked web-login run, as the agent family publishes it.
    fn blocked_run() -> SecurityNotice {
        use opensesame_agent_events::{AgentEvent, AgentPhase, AgentRun};
        AgentEvent::waiting(
            AgentRun {
                run_id: "run:1".into(),
                job_id: "job:1".into(),
                organization_id: "org-1".into(),
                owner_principal_id: "principal:alice".into(),
                origin: "https://example.com".into(),
                tier: "t4".into(),
                control_state: "suspended".into(),
            },
            AgentPhase::Blocked,
            now(),
            now() + chrono::Duration::seconds(3_600),
            Some("step-up challenge"),
        )
        .unwrap()
        .notice()
    }

    #[test]
    fn an_a2h_subscription_is_queued_a_delivery_like_any_other_sink() {
        // The bug this replaces: the agent family had its own fan-out whose
        // `wants_delivery` read `hook.delivery == "webhook"`, so an a2h
        // subscription — registrable, schema-valid, with a working send path
        // behind it — was never queued a single row. The whole channel was
        // unreachable, and nothing failed loudly enough to say so.
        //
        // Publishing through the shared dispatcher makes that unrepresentable:
        // `wants_delivery` asks the `Delivery` enum whether the sink is
        // outbound, so a sink added later is queued without anybody
        // remembering to widen a string comparison.
        let notice = blocked_run();
        for kind in [
            Delivery::Webhook,
            Delivery::Alertmanager,
            Delivery::PagerDuty,
            Delivery::A2h,
        ] {
            assert!(
                hooks::wants_delivery(&hook(kind), &notice),
                "{kind:?} would never be queued a delivery",
            );
        }

        let mut internal = hook(Delivery::Internal);
        internal.delivery = Delivery::Internal.as_str().into();
        internal.endpoint_url = None;
        internal.responder = Some("notify".into());
        assert!(
            !hooks::wants_delivery(&internal, &notice),
            "an in-process responder must not be queued a row nobody drains",
        );
    }

    #[test]
    fn an_agent_notice_reaches_the_ledger_as_the_envelope_a2h_reads_back() {
        // `send_a2h` and the callback route both decode the stored row as a
        // SecurityNotice and take `AgentEvent::from_payload` of its payload.
        // If fan-out ever stored the bare agent payload again, every a2h
        // delivery would dead-letter as "names no run owner".
        let notice = blocked_run();
        let payload = serde_json::to_string(&notice).unwrap();
        let row = pending_delivery(&hook(Delivery::A2h), &notice, payload, now());
        let decoded: SecurityNotice = serde_json::from_str(&row.payload_json).unwrap();
        let event = opensesame_agent_events::AgentEvent::from_payload(&decoded.payload)
            .expect("the stored envelope still rebuilds the run it is about");
        assert_eq!(event.run.owner_principal_id, "principal:alice");
        assert_eq!(event.run.origin, "https://example.com");
    }

    #[test]
    fn a_queued_delivery_carries_the_notice_and_its_routing_keys() {
        let notice = notice();
        let payload = serde_json::to_string(&notice).unwrap();
        let row = pending_delivery(&hook(Delivery::Webhook), &notice, payload, now());
        assert_eq!(row.event_type, "breach.password.compromised");
        assert_eq!(row.subject_kind, "store_path");
        assert_eq!(row.subject_id, "Dev/api-token");
        assert_eq!(row.state, "pending");
        assert_eq!(row.attempts, 0);
        assert!(row.id.starts_with("secd_"));
    }

    #[test]
    fn a_queued_payload_round_trips_into_the_notice_a_sink_renders() {
        let notice = notice();
        let payload = serde_json::to_string(&notice).unwrap();
        let row = pending_delivery(&hook(Delivery::PagerDuty), &notice, payload, now());
        let decoded: SecurityNotice = serde_json::from_str(&row.payload_json).unwrap();
        assert_eq!(decoded, notice);
    }

    #[test]
    fn the_bus_payload_is_sanitized_even_when_a_detector_was_careless() {
        let leaky = notice();
        let safe = leaky.safe_payload();
        assert!(
            safe.get("password").is_none(),
            "the bus must not carry a secret-shaped key",
        );
        assert_eq!(safe["occurrences"], json!(42));
    }
}
