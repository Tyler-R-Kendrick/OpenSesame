//! The built-in alerting subscriber.
//!
//! The notifier records everything. This one is about the events somebody has
//! to *act* on, and it does two things the notifier does not:
//!
//! - It states, in the record, that the event was alert-worthy and where the
//!   alert was routed. An operator reading logs after an incident can tell the
//!   difference between "we never detected it" and "we detected it and had
//!   nowhere to send it".
//! - When an organization has no alerting sink configured at all, it says so,
//!   once per event, at `error`. An alerting system that is quiet because
//!   nothing is wrong and one that is quiet because it is unplugged look
//!   identical from the outside, and that is the failure this exists to
//!   prevent.
//!
//! It deliberately does **not** send anything itself. The Alertmanager and
//! `PagerDuty` sinks are ordinary hook rows, queued by the dispatcher onto the
//! same retry ledger as every other outbound delivery, so an alert that cannot
//! be delivered right now is retried and dead-lettered visibly rather than
//! being dropped inside a responder. Two code paths to the same sink is how one
//! of them ends up untested.

use opensesame_security_events::SecurityNotice;
use opensesame_storage::StoredSecurityHook;

use crate::security::hooks;
use crate::security::notify::TARGET;

/// Record that a notice cleared the alerting floor, and where it went.
///
/// `sinks` is what the dispatcher queued for this notice; an empty slice is the
/// unplugged case.
pub fn raise(notice: &SecurityNotice, sinks: &[&StoredSecurityHook]) {
    let routes = sink_names(sinks);
    if sinks.is_empty() {
        tracing::error!(
            target: TARGET,
            event_type = %notice.event_type,
            severity = notice.severity.as_str(),
            subject_kind = %notice.subject_kind,
            subject_id = %notice.subject_id,
            alert_key = %notice.alert_key(),
            summary = %notice.summary_text(),
            "security alert has no configured route; register an alertmanager or pagerduty hook",
        );
        return;
    }
    tracing::warn!(
        target: TARGET,
        event_type = %notice.event_type,
        severity = notice.severity.as_str(),
        subject_kind = %notice.subject_kind,
        subject_id = %notice.subject_id,
        alert_key = %notice.alert_key(),
        state = notice.state.as_str(),
        routes = %routes,
        summary = %notice.summary_text(),
        "security alert routed",
    );
}

/// The sink names an alert was routed to, for the record.
///
/// Names and delivery kinds only. An endpoint URL can carry a token in a query
/// string, and a log line is exactly the place that would leak from.
#[must_use]
pub fn sink_names(sinks: &[&StoredSecurityHook]) -> String {
    sinks
        .iter()
        .map(|sink| format!("{}({})", sink.name, sink.delivery))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Whether the built-in alerter is registered and selects this notice.
#[must_use]
pub fn selects(all_hooks: &[StoredSecurityHook], notice: &SecurityNotice) -> bool {
    hooks::builtin_selects(all_hooks, hooks::ALERT_RESPONDER, notice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_security_events::{Delivery, NoticeState, Severity};
    use serde_json::json;

    fn notice(severity: Severity) -> SecurityNotice {
        SecurityNotice {
            event_type: "breach.password.compromised".into(),
            severity,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "store_path".into(),
            subject_id: "Dev/api-token".into(),
            label: None,
            occurred_at: "2026-08-30T00:00:00Z".parse().unwrap(),
            summary: "a stored secret appears in a public breach corpus".into(),
            detail: None,
            payload: json!({}),
        }
    }

    fn sink(name: &str, delivery: Delivery, endpoint: &str) -> StoredSecurityHook {
        StoredSecurityHook {
            id: format!("hook:{name}"),
            organization_id: "org-1".into(),
            name: name.into(),
            event_types: vec!["*".into()],
            delivery: delivery.as_str().into(),
            endpoint_url: Some(endpoint.into()),
            responder: None,
            subject_kinds: None,
            severity_min: "warning".into(),
            enabled: true,
            sealed_secret: None,
            last_delivered_at: None,
            last_error: None,
            version: 1,
            created_at: "2026-08-30T00:00:00+00:00".into(),
            updated_at: "2026-08-30T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn routes_are_named_by_hook_and_kind() {
        let pager = sink(
            "oncall",
            Delivery::PagerDuty,
            "https://events.pagerduty.com/v2/enqueue",
        );
        let alertmanager = sink(
            "prom",
            Delivery::Alertmanager,
            "https://am.example/api/v2/alerts",
        );
        let names = sink_names(&[&pager, &alertmanager]);
        assert_eq!(names, "oncall(pagerduty), prom(alertmanager)");
    }

    #[test]
    fn an_endpoint_never_reaches_the_record() {
        let secretive = sink(
            "leaky",
            Delivery::Alertmanager,
            "https://am.example/api/v2/alerts?token=supersecret",
        );
        let names = sink_names(&[&secretive]);
        assert!(
            !names.contains("supersecret"),
            "an endpoint query string must not reach a log line: {names}",
        );
    }

    #[test]
    fn raising_is_infallible_with_and_without_a_route() {
        let pager = sink(
            "oncall",
            Delivery::PagerDuty,
            "https://events.pagerduty.com/v2/enqueue",
        );
        raise(&notice(Severity::Critical), &[&pager]);
        raise(&notice(Severity::Critical), &[]);
    }

    #[test]
    fn the_builtin_alerter_selects_loud_events_only() {
        let defaults = hooks::default_hooks("org-1", "2026-08-30T00:00:00Z".parse().unwrap());
        assert!(selects(&defaults, &notice(Severity::Critical)));
        assert!(selects(&defaults, &notice(Severity::Warning)));
        assert!(!selects(&defaults, &notice(Severity::Info)));
    }

    #[test]
    fn a_disabled_builtin_alerter_selects_nothing() {
        let mut defaults = hooks::default_hooks("org-1", "2026-08-30T00:00:00Z".parse().unwrap());
        for hook in &mut defaults {
            hook.enabled = false;
        }
        assert!(!selects(&defaults, &notice(Severity::Critical)));
    }

    #[test]
    fn no_sinks_renders_as_an_empty_route_list() {
        assert_eq!(sink_names(&[]), "");
    }
}
