//! Subscription matching, and the two subscribers that are always there.
//!
//! A hook row is the same row whatever family the event came from. That is the
//! whole point of the rename in migration 0020: expiry and breach findings
//! share one subscription table, so an operator who wired their alerting once
//! gets the second detector for free.
//!
//! Two of those rows are seeded by the platform rather than by an operator.
//! They are the answer to "who is listening the day this is deployed?", which
//! for an alerting system had better not be "nobody until somebody configures
//! something". They exist as ordinary rows so they show up in the same list as
//! everything else — an operator can see them, and can disable them.

use chrono::{DateTime, Utc};
use opensesame_security_events::{filter, Delivery, SecurityNotice, Severity};
use opensesame_storage::StoredSecurityHook;

use crate::app_state::AppState;

/// Responder id of the built-in notifier: records every security event where a
/// host log collector will see it.
pub const NOTIFY_RESPONDER: &str = "notify";
/// Responder id of the built-in alerter: escalates events at or above its
/// floor, and makes an absent alert route visible instead of silent.
pub const ALERT_RESPONDER: &str = "alert";

/// Severity floor of the built-in alerter.
///
/// `Warning` rather than `Error`: the rungs below it are informational by
/// construction (a 30-day expiry notice), and the rungs at it are the first
/// point at which somebody has to plan to do something.
pub const ALERT_FLOOR: Severity = Severity::Warning;

/// The id of a built-in subscription for one organization.
///
/// Deterministic, so seeding is an idempotent insert rather than a search, and
/// organization-scoped, because `security_hooks.id` is the primary key.
#[must_use]
pub fn builtin_id(responder: &str, organization_id: &str) -> String {
    format!("sech_builtin_{responder}_{organization_id}")
}

/// The default subscriptions every organization gets.
///
/// Returned as data rather than written directly so the seeding is testable
/// without a database, and so the row shapes stay in one place.
#[must_use]
pub fn default_hooks(organization_id: &str, now: DateTime<Utc>) -> Vec<StoredSecurityHook> {
    [
        (NOTIFY_RESPONDER, "built-in notification", Severity::Info),
        (ALERT_RESPONDER, "built-in alerting", ALERT_FLOOR),
    ]
    .into_iter()
    .map(|(responder, name, floor)| StoredSecurityHook {
        // The organization is part of the id, not only of the row. `id` is the
        // table's primary key, so an id shared across tenants would make the
        // second tenant's seeding collide with the first's row instead of
        // creating its own — leaving every organization but one with no
        // built-in subscribers at all, silently. That is precisely the failure
        // these two rows exist to prevent, so it must not be possible to
        // reintroduce it: `builtin_id` is the only way one is named.
        id: builtin_id(responder, organization_id),
        organization_id: organization_id.to_string(),
        name: name.to_string(),
        // Every family, including families added later. A built-in subscriber
        // that had to be edited for each new detector is a built-in subscriber
        // that silently stops covering the newest one.
        event_types: vec![filter::WILDCARD_ALL.to_string()],
        delivery: Delivery::Internal.as_str().to_string(),
        endpoint_url: None,
        responder: Some(responder.to_string()),
        subject_kinds: None,
        severity_min: floor.as_str().to_string(),
        enabled: true,
        sealed_secret: None,
        last_delivered_at: None,
        last_error: None,
        version: 1,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    })
    .collect()
}

/// Write the default subscriptions for an organization if they are missing.
///
/// Idempotent and non-fatal. A row an operator disabled stays disabled: this
/// only ever inserts, never revives, because re-enabling something somebody
/// deliberately turned off is worse than leaving it off.
pub async fn ensure_defaults(state: &AppState, organization_id: &str, now: DateTime<Utc>) {
    for hook in default_hooks(organization_id, now) {
        match state.db.get_security_hook(organization_id, &hook.id).await {
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, hook_id = %hook.id, "could not check for a built-in subscription");
                continue;
            }
        }
        if let Err(error) = state.db.upsert_security_hook(&hook).await {
            tracing::warn!(%error, hook_id = %hook.id, "could not seed a built-in subscription");
        }
    }
}

/// The severity floor a row carries, defaulting to `Info` when it is
/// unreadable.
///
/// Unreadable means admit everything, not admit nothing: a row with a typo in
/// its floor should be noisy, not silently deaf.
#[must_use]
pub fn floor_of(hook: &StoredSecurityHook) -> Severity {
    Severity::parse(&hook.severity_min).unwrap_or(Severity::Info)
}

/// Whether a stored subscription selects this notice.
///
/// Four gates, all required: the row is enabled, the event filter names it,
/// the severity clears the row's floor, and the subject kind is one the row
/// asked for. An empty event filter matches nothing.
#[must_use]
pub fn hook_matches(hook: &StoredSecurityHook, notice: &SecurityNotice) -> bool {
    if !hook.enabled {
        return false;
    }
    if !filter::matches(&hook.event_types, &notice.event_type) {
        return false;
    }
    if !notice.severity.at_least(floor_of(hook)) {
        return false;
    }
    match &hook.subject_kinds {
        None => true,
        Some(kinds) => kinds.contains(&notice.subject_kind),
    }
}

/// Whether this subscription should receive an outbound delivery.
///
/// An internal row documents a platform subscriber that runs in process, so
/// queueing an outbound delivery for it would write a ledger row nobody drains.
#[must_use]
pub fn wants_delivery(hook: &StoredSecurityHook, notice: &SecurityNotice) -> bool {
    Delivery::parse(&hook.delivery).is_some_and(Delivery::is_outbound) && hook_matches(hook, notice)
}

/// Whether the built-in subscriber with this responder id selects the notice.
///
/// When a row for it exists it is honoured exactly — disabled means disabled,
/// and its severity floor applies. When **no** row exists the built-in's own
/// default definition is used instead, which is what makes "these two are
/// always listening" unconditional rather than dependent on seeding having
/// already run.
///
/// That matters for a narrow but real window: an event published from a route
/// on a freshly started gateway can reach here before either scanner's first
/// tick has seeded anything, and a `critical` finding reaching no notifier is
/// precisely the silence this subsystem exists to prevent. It also makes
/// deleting a row behave like the re-seed that follows it, rather than
/// differently until the next tick. Turning one off is `enabled: false`.
#[must_use]
pub fn builtin_selects(
    hooks: &[StoredSecurityHook],
    responder: &str,
    notice: &SecurityNotice,
) -> bool {
    let mut configured = hooks
        .iter()
        .filter(|hook| hook.responder.as_deref() == Some(responder))
        .peekable();
    if configured.peek().is_some() {
        return configured.any(|hook| hook_matches(hook, notice));
    }
    default_hooks(&notice.organization_id, notice.occurred_at)
        .iter()
        .filter(|hook| hook.responder.as_deref() == Some(responder))
        .any(|hook| hook_matches(hook, notice))
}

/// Every outbound alerting sink an organization has configured for this notice.
///
/// Used to tell an operator that an alert had nowhere to go, which is the one
/// thing an alerting system must never be quiet about.
#[must_use]
pub fn alert_sinks<'a>(
    hooks: &'a [StoredSecurityHook],
    notice: &SecurityNotice,
) -> Vec<&'a StoredSecurityHook> {
    hooks
        .iter()
        .filter(|hook| {
            matches!(
                Delivery::parse(&hook.delivery),
                Some(Delivery::Alertmanager | Delivery::PagerDuty)
            ) && hook_matches(hook, notice)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_security_events::NoticeState;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        "2026-08-30T00:00:00Z".parse().unwrap()
    }

    fn notice(event_type: &str, severity: Severity) -> SecurityNotice {
        SecurityNotice {
            event_type: event_type.into(),
            severity,
            state: NoticeState::Firing,
            organization_id: "org:1".into(),
            subject_kind: "certificate".into(),
            subject_id: "cert-1".into(),
            label: None,
            occurred_at: now(),
            summary: "something".into(),
            detail: None,
            payload: json!({}),
        }
    }

    fn hook(delivery: Delivery, floor: Severity) -> StoredSecurityHook {
        StoredSecurityHook {
            id: "hook:1".into(),
            organization_id: "org:1".into(),
            name: "sink".into(),
            event_types: vec![filter::WILDCARD_ALL.into()],
            delivery: delivery.as_str().into(),
            endpoint_url: delivery
                .is_outbound()
                .then(|| "https://sink.example/in".to_string()),
            responder: delivery
                .requires_responder()
                .then(|| ALERT_RESPONDER.to_string()),
            subject_kinds: None,
            severity_min: floor.as_str().into(),
            enabled: true,
            sealed_secret: None,
            last_delivered_at: None,
            last_error: None,
            version: 1,
            created_at: now().to_rfc3339(),
            updated_at: now().to_rfc3339(),
        }
    }

    #[test]
    fn two_organizations_get_two_distinct_rows() {
        let first = default_hooks("org:1", now());
        let second = default_hooks("org:2", now());
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!(a.responder, b.responder);
            assert_ne!(
                a.id, b.id,
                "`id` is the primary key: a shared id would make one tenant's \
                 seeding overwrite another's row instead of creating its own",
            );
        }
        assert_eq!(first[0].organization_id, "org:1");
        assert_eq!(second[0].organization_id, "org:2");
    }

    #[test]
    fn a_builtin_id_is_stable_for_one_organization() {
        assert_eq!(
            builtin_id(ALERT_RESPONDER, "org:1"),
            default_hooks("org:1", now())
                .into_iter()
                .find(|hook| hook.responder.as_deref() == Some(ALERT_RESPONDER))
                .unwrap()
                .id,
        );
    }

    #[test]
    fn the_defaults_cover_every_family_including_ones_added_later() {
        let defaults = default_hooks("org:1", now());
        assert_eq!(defaults.len(), 2);
        for hook in &defaults {
            assert_eq!(hook.event_types, vec![filter::WILDCARD_ALL.to_string()]);
            assert_eq!(hook.delivery, Delivery::Internal.as_str());
            assert_eq!(hook.endpoint_url, None);
            assert!(hook.sealed_secret.is_none());
        }
    }

    #[test]
    fn the_built_ins_listen_even_before_seeding_has_run() {
        // A route can publish on a freshly started gateway, before either
        // scanner's first tick.
        let loud = notice("breach.password.compromised", Severity::Critical);
        assert!(builtin_selects(&[], NOTIFY_RESPONDER, &loud));
        assert!(builtin_selects(&[], ALERT_RESPONDER, &loud));
    }

    #[test]
    fn the_unseeded_fallback_still_respects_the_alerters_floor() {
        let quiet = notice("lifecycle.expiry.notice", Severity::Info);
        assert!(builtin_selects(&[], NOTIFY_RESPONDER, &quiet));
        assert!(
            !builtin_selects(&[], ALERT_RESPONDER, &quiet),
            "the fallback must not page for something the configured row would not",
        );
    }

    #[test]
    fn a_disabled_row_is_honoured_rather_than_replaced_by_the_default() {
        let loud = notice("breach.password.compromised", Severity::Critical);
        let mut rows = default_hooks("org:1", now());
        for row in &mut rows {
            row.enabled = false;
        }
        assert!(
            !builtin_selects(&rows, ALERT_RESPONDER, &loud),
            "an existing row is the operator's decision, not a gap to fill",
        );
        assert!(!builtin_selects(&rows, NOTIFY_RESPONDER, &loud));
    }

    #[test]
    fn one_built_in_present_does_not_suppress_the_others_fallback() {
        let loud = notice("breach.password.compromised", Severity::Critical);
        let notify_only: Vec<_> = default_hooks("org:1", now())
            .into_iter()
            .filter(|hook| hook.responder.as_deref() == Some(NOTIFY_RESPONDER))
            .map(|mut hook| {
                hook.enabled = false;
                hook
            })
            .collect();
        assert!(!builtin_selects(&notify_only, NOTIFY_RESPONDER, &loud));
        assert!(
            builtin_selects(&notify_only, ALERT_RESPONDER, &loud),
            "the alerter has no row here, so its default applies",
        );
    }

    #[test]
    fn the_notifier_hears_everything_and_the_alerter_only_what_is_loud() {
        let defaults = default_hooks("org:1", now());
        let quiet = notice("lifecycle.expiry.notice", Severity::Info);
        assert!(builtin_selects(&defaults, NOTIFY_RESPONDER, &quiet));
        assert!(
            !builtin_selects(&defaults, ALERT_RESPONDER, &quiet),
            "a 30-day notice must not page anyone",
        );

        let loud = notice("breach.password.compromised", Severity::Critical);
        assert!(builtin_selects(&defaults, NOTIFY_RESPONDER, &loud));
        assert!(builtin_selects(&defaults, ALERT_RESPONDER, &loud));
    }

    #[test]
    fn a_severity_floor_filters_out_quieter_events() {
        let paging = hook(Delivery::PagerDuty, Severity::Critical);
        assert!(!hook_matches(
            &paging,
            &notice("breach.scan.failed", Severity::Warning)
        ));
        assert!(hook_matches(
            &paging,
            &notice("breach.password.compromised", Severity::Critical),
        ));
    }

    #[test]
    fn an_unreadable_floor_admits_everything_rather_than_going_deaf() {
        let mut broken = hook(Delivery::Webhook, Severity::Info);
        broken.severity_min = "loud".into();
        assert_eq!(floor_of(&broken), Severity::Info);
        assert!(hook_matches(
            &broken,
            &notice("lifecycle.expiry.notice", Severity::Info)
        ));
    }

    #[test]
    fn a_disabled_hook_matches_nothing() {
        let mut off = hook(Delivery::Webhook, Severity::Info);
        off.enabled = false;
        assert!(!hook_matches(
            &off,
            &notice("breach.scan.failed", Severity::Critical)
        ));
    }

    #[test]
    fn a_hook_naming_no_events_matches_nothing() {
        let mut empty = hook(Delivery::Webhook, Severity::Info);
        empty.event_types = vec![];
        assert!(!hook_matches(
            &empty,
            &notice("lifecycle.renewal.due", Severity::Warning)
        ));
    }

    #[test]
    fn a_subject_kind_filter_narrows_further() {
        let mut certs_only = hook(Delivery::Webhook, Severity::Info);
        certs_only.subject_kinds = Some(vec!["certificate".into()]);
        assert!(hook_matches(
            &certs_only,
            &notice("lifecycle.renewal.due", Severity::Warning)
        ));

        let mut store = notice("breach.password.compromised", Severity::Critical);
        store.subject_kind = "store_path".into();
        assert!(!hook_matches(&certs_only, &store));
    }

    #[test]
    fn only_outbound_rows_are_queued_for_delivery() {
        let loud = notice("breach.password.compromised", Severity::Critical);
        for delivery in Delivery::ALL {
            let row = hook(delivery, Severity::Info);
            assert_eq!(
                wants_delivery(&row, &loud),
                delivery.is_outbound(),
                "{delivery:?}"
            );
        }
    }

    #[test]
    fn a_row_with_an_unknown_delivery_kind_is_never_queued() {
        let mut alien = hook(Delivery::Webhook, Severity::Info);
        alien.delivery = "carrier-pigeon".into();
        assert!(!wants_delivery(
            &alien,
            &notice("breach.password.compromised", Severity::Critical),
        ));
    }

    #[test]
    fn only_alerting_sinks_count_as_an_alert_route() {
        let loud = notice("breach.password.compromised", Severity::Critical);
        let rows = vec![
            hook(Delivery::Webhook, Severity::Info),
            hook(Delivery::Alertmanager, Severity::Info),
            hook(Delivery::PagerDuty, Severity::Info),
            hook(Delivery::Internal, Severity::Info),
        ];
        let sinks = alert_sinks(&rows, &loud);
        assert_eq!(sinks.len(), 2);
        assert!(sinks
            .iter()
            .all(|sink| sink.delivery == "alertmanager" || sink.delivery == "pagerduty"));
    }

    #[test]
    fn an_organization_with_no_sinks_reports_none() {
        let loud = notice("breach.password.compromised", Severity::Critical);
        assert!(alert_sinks(&[hook(Delivery::Webhook, Severity::Info)], &loud).is_empty());
    }
}
