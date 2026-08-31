//! Fan-out for the `agent.*` feed (ADR 0081).
//!
//! Deliberately the *same* subscription table, the same delivery ledger and the
//! same Standard Webhooks worker the expiry feed uses. A run that blocks is
//! announced on a feed anybody can subscribe to, and `OpenSesame`'s own
//! notification is one of those subscribers — which is ADR 0074's rule that the
//! platform has no private trigger path that could let the public one rot.
//!
//! What is *not* shared is the vocabulary: `crates/agent-events` owns the
//! `agent.*` names and their payloads, exactly as `crates/lifecycle` owns
//! `lifecycle.*`. A hook may name events from either family, or both.

use chrono::{DateTime, Utc};
use opensesame_agent_events::{filter_matches, AgentEvent};
use opensesame_storage::{StoredSecurityDelivery, StoredSecurityHook};
use opensesame_task_bus::BusEvent;

use crate::app_state::AppState;

const BUS_SOURCE: &str = "opensesame://gateway/agent";

/// The subject kind an agent run reports under, so a subscription can narrow to
/// it the same way one narrows to certificates.
pub const AGENT_SUBJECT_KIND: &str = "web_login";

/// Publish one agent fact and queue it for every matching subscriber.
///
/// Every step is best-effort and logged rather than fatal. A runner reporting
/// that it is blocked must not itself fail because one subscriber's row would
/// not write — the run is already stuck, and losing the notification is how a
/// stuck run becomes a silent one.
pub async fn publish(state: &AppState, event: &AgentEvent, now: DateTime<Utc>) {
    publish_to_bus(state, event).await;
    enqueue_for_subscribers(state, event, now).await;
}

/// Publish on the `TaskBus`. The bus accelerates and observes; the delivery
/// ledger is the source of truth, so a bus outage never loses a hook.
async fn publish_to_bus(state: &AppState, event: &AgentEvent) {
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
            "agent TaskBus publish failed; the delivery ledger still carries it",
        );
    }
}

/// Whether a stored subscription selects this event.
///
/// Both filters must pass, and an empty event filter matches nothing — a hook
/// that names no events is a misconfiguration, and defaulting it to
/// "everything" is the wrong direction to fail.
#[must_use]
pub fn hook_matches(hook: &StoredSecurityHook, event: &AgentEvent) -> bool {
    if !hook.enabled {
        return false;
    }
    if !filter_matches(&hook.event_types, &event.event_type) {
        return false;
    }
    match &hook.subject_kinds {
        None => true,
        Some(kinds) => kinds.iter().any(|kind| kind == AGENT_SUBJECT_KIND),
    }
}

/// Whether this subscription should receive an outbound delivery.
///
/// `internal` rows document a platform responder that runs in process, so
/// queueing an outbound delivery for one would be a row nobody drains.
fn wants_delivery(hook: &StoredSecurityHook, event: &AgentEvent) -> bool {
    hook.delivery == "webhook" && hook_matches(hook, event)
}

/// One queued delivery of `event` to `hook`.
fn pending_delivery(
    hook: &StoredSecurityHook,
    event: &AgentEvent,
    payload_json: String,
    now: DateTime<Utc>,
) -> StoredSecurityDelivery {
    StoredSecurityDelivery {
        id: format!("lcd_{}", uuid::Uuid::now_v7()),
        organization_id: hook.organization_id.clone(),
        hook_id: hook.id.clone(),
        event_type: event.event_type.clone(),
        subject_kind: AGENT_SUBJECT_KIND.to_string(),
        // The relying party, which is what a subscriber deduplicates and
        // rate-limits on. Never an account.
        subject_id: event.run.origin.clone(),
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

/// The subscriptions and the encoded payload one fan-out needs.
///
/// `None` when either could not be obtained, which is logged here so the
/// caller stays a loop rather than a funnel of early returns.
async fn fanout_inputs(
    state: &AppState,
    event: &AgentEvent,
) -> Option<(Vec<StoredSecurityHook>, String)> {
    let hooks = state
        .db
        .list_security_hooks(&event.run.organization_id)
        .await
        .inspect_err(|error| {
            tracing::warn!(%error, "agent fan-out could not read subscriptions");
        })
        .ok()?;
    let payload = serde_json::to_string(&event.payload())
        .inspect_err(|error| {
            tracing::warn!(%error, "agent payload could not be encoded");
        })
        .ok()?;
    Some((hooks, payload))
}

async fn enqueue_for_subscribers(state: &AppState, event: &AgentEvent, now: DateTime<Utc>) {
    let Some((hooks, payload)) = fanout_inputs(state, event).await else {
        return;
    };
    for hook in hooks.iter().filter(|hook| wants_delivery(hook, event)) {
        let delivery = pending_delivery(hook, event, payload.clone(), now);
        if let Err(error) = state.db.enqueue_security_delivery(&delivery).await {
            tracing::warn!(%error, hook_id = %hook.id, "agent delivery could not be queued");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_agent_events::{
        AgentPhase, AgentRun, EVENT_RUN_BLOCKED, EVENT_RUN_COMPLETED, EVENT_WILDCARD,
    };

    fn now() -> DateTime<Utc> {
        "2026-08-31T00:00:00Z".parse().unwrap()
    }

    fn blocked() -> AgentEvent {
        AgentEvent::waiting(
            AgentRun {
                run_id: "run:1".into(),
                job_id: "job:1".into(),
                organization_id: "org:1".into(),
                owner_principal_id: "principal:alice".into(),
                origin: "https://example.com".into(),
                tier: "t4".into(),
                control_state: "suspended".into(),
            },
            AgentPhase::Blocked,
            now(),
            now() + chrono::Duration::seconds(300),
            Some("step-up challenge"),
        )
        .unwrap()
    }

    fn hook(event_types: &[&str], kinds: Option<&[&str]>) -> StoredSecurityHook {
        StoredSecurityHook {
            id: "hook:1".into(),
            organization_id: "org:1".into(),
            name: "agent".into(),
            event_types: event_types.iter().map(|s| (*s).to_string()).collect(),
            delivery: "webhook".into(),
            severity_min: "info".into(),
            endpoint_url: Some("https://hooks.example/agent".into()),
            responder: None,
            subject_kinds: kinds.map(|k| k.iter().map(|s| (*s).to_string()).collect()),
            enabled: true,
            sealed_secret: None,
            last_delivered_at: None,
            last_error: None,
            version: 1,
            created_at: "2026-08-31T00:00:00+00:00".into(),
            updated_at: "2026-08-31T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn an_exact_name_and_the_wildcard_both_select() {
        assert!(hook_matches(&hook(&[EVENT_RUN_BLOCKED], None), &blocked()));
        assert!(hook_matches(&hook(&[EVENT_WILDCARD], None), &blocked()));
    }

    #[test]
    fn a_filter_naming_other_events_does_not_select() {
        assert!(!hook_matches(
            &hook(&[EVENT_RUN_COMPLETED], None),
            &blocked()
        ));
        // The other family's wildcard is not this family's.
        assert!(!hook_matches(&hook(&["lifecycle.*"], None), &blocked()));
    }

    #[test]
    fn an_empty_filter_matches_nothing() {
        assert!(!hook_matches(&hook(&[], None), &blocked()));
    }

    #[test]
    fn a_disabled_hook_never_matches() {
        let mut disabled = hook(&[EVENT_WILDCARD], None);
        disabled.enabled = false;
        assert!(!hook_matches(&disabled, &blocked()));
    }

    #[test]
    fn subject_kind_narrowing_works_the_same_way_it_does_for_expiry() {
        assert!(hook_matches(
            &hook(&[EVENT_WILDCARD], Some(&["web_login"])),
            &blocked()
        ));
        assert!(!hook_matches(
            &hook(&[EVENT_WILDCARD], Some(&["certificate"])),
            &blocked()
        ));
    }

    #[test]
    fn an_internal_responder_row_is_not_a_delivery_target() {
        let mut internal = hook(&[EVENT_WILDCARD], None);
        internal.delivery = "internal".into();
        internal.endpoint_url = None;
        internal.responder = Some("rotation".into());
        assert!(hook_matches(&internal, &blocked()));
        assert!(!wants_delivery(&internal, &blocked()));
    }

    #[test]
    fn a_queued_delivery_carries_the_origin_and_no_body() {
        let event = blocked();
        let payload = serde_json::to_string(&event.payload()).unwrap();
        let delivery = pending_delivery(&hook(&[EVENT_WILDCARD], None), &event, payload, now());
        assert_eq!(delivery.subject_kind, AGENT_SUBJECT_KIND);
        assert_eq!(delivery.subject_id, "https://example.com");
        assert_eq!(delivery.event_type, EVENT_RUN_BLOCKED);
        assert_eq!(delivery.state, "pending");
        assert!(delivery.payload_json.contains("\"needs_human\":true"));
        assert!(delivery
            .payload_json
            .contains("\"observation_included\":false"));
    }
}
