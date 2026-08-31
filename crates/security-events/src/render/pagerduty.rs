//! `PagerDuty` Events API v2 rendering.
//!
//! `POST https://events.pagerduty.com/v2/enqueue`. The routing key is an
//! integration secret, so it is sealed at rest with the rest of a
//! subscription's material and passed in here rather than stored on a notice —
//! a rendered body is a thing we log and inspect, and the key must not be in
//! whatever we happen to render for debugging.
//!
//! `dedup_key` is the whole reason this sink is worth having: `PagerDuty`
//! collapses every trigger sharing one into a single incident, and a later
//! `resolve` with that key closes it. Our alert key is per-subject, so a
//! certificate that warns at 30 days, 7 days, and 24 hours is one incident,
//! and its renewal resolves it.

use serde_json::{json, Map, Value};

use crate::notice::SecurityNotice;

/// The public Events API v2 endpoint.
pub const ENQUEUE_URL: &str = "https://events.pagerduty.com/v2/enqueue";
/// `client` shown on the incident in `PagerDuty`'s UI.
pub const CLIENT_NAME: &str = "OpenSesame";

/// Whether this notice triggers an incident or resolves one.
#[must_use]
pub fn event_action(notice: &SecurityNotice) -> &'static str {
    if notice.state.is_resolved() {
        "resolve"
    } else {
        "trigger"
    }
}

/// Render one notice as an Events API v2 request body.
///
/// A resolve carries only the three fields the API requires. That is not an
/// optimization: `PagerDuty` ignores `payload` on a resolve, and sending one
/// anyway would put event detail on the wire for a condition that no longer
/// holds.
#[must_use]
pub fn render(notice: &SecurityNotice, routing_key: &str) -> Value {
    let mut body = Map::new();
    body.insert("routing_key".into(), json!(routing_key));
    body.insert("event_action".into(), json!(event_action(notice)));
    body.insert("dedup_key".into(), json!(notice.alert_key()));
    if notice.state.is_resolved() {
        return Value::Object(body);
    }
    body.insert("client".into(), json!(CLIENT_NAME));
    body.insert("payload".into(), payload(notice));
    Value::Object(body)
}

/// The incident body. `source`, `component`, `group`, and `class` are
/// `PagerDuty`'s own taxonomy; filling them in is what makes their event rules
/// able to route our events without a per-customer regex over the summary.
fn payload(notice: &SecurityNotice) -> Value {
    let mut body = Map::new();
    body.insert("summary".into(), json!(notice.summary_text()));
    body.insert("timestamp".into(), json!(notice.occurred_at.to_rfc3339()));
    body.insert("severity".into(), json!(notice.severity.as_str()));
    // `source` is required by the API, and an empty one is a 400 the delivery
    // worker reads as permanent. Falling back keeps a subject with no id from
    // becoming an alert nobody ever receives.
    body.insert(
        "source".into(),
        json!(if notice.subject_id.is_empty() {
            notice.subject_kind.as_str()
        } else {
            notice.subject_id.as_str()
        }),
    );
    body.insert(
        "component".into(),
        json!(notice
            .label_text()
            .unwrap_or_else(|| notice.subject_kind.clone())),
    );
    body.insert("group".into(), json!(notice.subject_kind));
    body.insert("class".into(), json!(notice.event_type));
    body.insert("custom_details".into(), custom_details(notice));
    Value::Object(body)
}

fn custom_details(notice: &SecurityNotice) -> Value {
    let mut details = Map::new();
    details.insert("organization".into(), json!(notice.organization_id));
    details.insert("event_family".into(), json!(notice.family()));
    if let Some(detail) = notice.detail_text() {
        details.insert("detail".into(), json!(detail));
    }
    if let Some(object) = notice.safe_payload().as_object() {
        for (key, value) in object {
            details.insert(key.clone(), value.clone());
        }
    }
    Value::Object(details)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notice::NoticeState;
    use crate::severity::Severity;

    const ROUTING_KEY: &str = "R0UT1NGK3Y";

    fn notice() -> SecurityNotice {
        SecurityNotice {
            event_type: "breach.password.compromised".into(),
            severity: Severity::Critical,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "store_path".into(),
            subject_id: "Dev/api-token".into(),
            label: Some("Dev/api-token".into()),
            occurred_at: "2026-08-30T00:00:00Z".parse().unwrap(),
            summary: "a stored secret appears in a public breach corpus".into(),
            detail: Some("seen 42 times".into()),
            payload: json!({"occurrences": 42, "password": "hunter2"}),
        }
    }

    #[test]
    fn a_firing_notice_triggers_an_incident() {
        let body = render(&notice(), ROUTING_KEY);
        assert_eq!(body["event_action"], json!("trigger"));
        assert_eq!(body["payload"]["severity"], json!("critical"));
        assert_eq!(body["client"], json!(CLIENT_NAME));
    }

    #[test]
    fn a_resolve_carries_only_what_the_api_requires() {
        let mut settled = notice();
        settled.state = NoticeState::Resolved;
        let body = render(&settled, ROUTING_KEY);
        // serde_json orders object keys, so compare the set, not the order.
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["dedup_key", "event_action", "routing_key"]);
        assert_eq!(body["event_action"], json!("resolve"));
    }

    #[test]
    fn the_dedup_key_is_the_subjects_alert_key() {
        let body = render(&notice(), ROUTING_KEY);
        assert_eq!(body["dedup_key"], json!(notice().alert_key()));
    }

    #[test]
    fn a_trigger_and_its_resolve_share_a_dedup_key() {
        let firing = render(&notice(), ROUTING_KEY);
        let mut settled = notice();
        settled.state = NoticeState::Resolved;
        settled.event_type = "breach.finding.cleared".into();
        let resolved = render(&settled, ROUTING_KEY);
        assert_eq!(firing["dedup_key"], resolved["dedup_key"]);
    }

    #[test]
    fn severity_is_pagerduty_vocabulary_verbatim() {
        for level in Severity::ALL {
            let mut at = notice();
            at.severity = level;
            let body = render(&at, ROUTING_KEY);
            assert!(["info", "warning", "error", "critical"]
                .contains(&body["payload"]["severity"].as_str().unwrap()));
        }
    }

    #[test]
    fn secret_shaped_payload_keys_never_reach_custom_details() {
        let body = render(&notice(), ROUTING_KEY);
        let details = &body["payload"]["custom_details"];
        assert!(details.get("password").is_none());
        assert_eq!(details["occurrences"], json!(42));
        assert!(!serde_json::to_string(&body).unwrap().contains("hunter2"));
    }

    #[test]
    fn the_routing_key_appears_exactly_where_the_api_wants_it_and_nowhere_else() {
        let body = render(&notice(), ROUTING_KEY);
        assert_eq!(body["routing_key"], json!(ROUTING_KEY));
        let without_key = {
            let mut copy = body.clone();
            copy.as_object_mut().unwrap().remove("routing_key");
            copy
        };
        assert!(!serde_json::to_string(&without_key)
            .unwrap()
            .contains(ROUTING_KEY));
    }

    #[test]
    fn an_empty_subject_id_still_produces_a_source_the_api_accepts() {
        let mut anonymous = notice();
        anonymous.subject_id = String::new();
        let body = render(&anonymous, ROUTING_KEY);
        assert_eq!(body["payload"]["source"], json!("store_path"));
        assert!(!body["payload"]["source"].as_str().unwrap().is_empty());
    }

    #[test]
    fn the_component_falls_back_to_the_subject_kind_without_a_label() {
        let mut unlabelled = notice();
        unlabelled.label = None;
        let body = render(&unlabelled, ROUTING_KEY);
        assert_eq!(body["payload"]["component"], json!("store_path"));
    }
}
