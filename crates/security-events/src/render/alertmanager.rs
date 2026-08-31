//! Prometheus Alertmanager v2 rendering.
//!
//! `POST /api/v2/alerts` takes a JSON array of alerts. The wire shape is
//! Alertmanager's, not ours: label/annotation split, RFC3339 `startsAt`, and
//! resolution by an `endsAt` in the past. An operator points us at their
//! existing Alertmanager and their existing routing tree, silences, and
//! inhibition rules apply to our events with nothing to configure on our side.
//!
//! Labels are the identity of an alert and drive grouping and deduplication,
//! so only low-cardinality metadata goes there. Anything free-form — the
//! summary, the label, the source payload — is an annotation, which
//! Alertmanager does not group on.

use serde_json::{json, Map, Value};

use crate::notice::SecurityNotice;

/// Alertmanager's v2 alert-ingest path, appended to an operator's base URL.
pub const INGEST_PATH: &str = "/api/v2/alerts";

/// The `source` label every alert carries, so a routing tree can select ours.
pub const SOURCE_LABEL: &str = "opensesame";

/// Render one notice as an Alertmanager v2 request body.
///
/// The body is an array because that is what the endpoint takes; a caller
/// batching several notices concatenates the arrays rather than nesting them.
#[must_use]
pub fn render(notice: &SecurityNotice) -> Value {
    json!([alert(notice)])
}

/// One alert object.
///
/// `endsAt` is set only on a resolved notice. Alertmanager treats an alert
/// with no `endsAt` as ongoing and re-arms its own resolve timeout, which is
/// what we want while a certificate is still expiring; setting it to the
/// resolve time is what closes the alert once the certificate is renewed.
#[must_use]
pub fn alert(notice: &SecurityNotice) -> Value {
    let mut body = Map::new();
    body.insert("labels".into(), labels(notice));
    body.insert("annotations".into(), annotations(notice));
    body.insert("startsAt".into(), json!(notice.occurred_at.to_rfc3339()));
    if notice.state.is_resolved() {
        body.insert("endsAt".into(), json!(notice.occurred_at.to_rfc3339()));
    }
    Value::Object(body)
}

/// Grouping identity. Every key here is a fixed, low-cardinality name and
/// every value comes from metadata.
fn labels(notice: &SecurityNotice) -> Value {
    json!({
        "alertname": notice.event_type,
        "severity": notice.severity.as_str(),
        "source": SOURCE_LABEL,
        "event_family": notice.family(),
        "event_type": notice.event_type,
        "subject_kind": notice.subject_kind,
        "subject_id": notice.subject_id,
        "organization": notice.organization_id,
        "alert_key": notice.alert_key(),
    })
}

/// Free-form context. Not grouped on, so cardinality is not a concern here.
fn annotations(notice: &SecurityNotice) -> Value {
    let mut body = Map::new();
    body.insert("summary".into(), json!(notice.summary_text()));
    if let Some(label) = notice.label_text() {
        body.insert("subject_label".into(), json!(label));
    }
    if let Some(detail) = notice.detail_text() {
        body.insert("detail".into(), json!(detail));
    }
    body.insert("event".into(), notice.safe_payload());
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notice::NoticeState;
    use crate::severity::Severity;

    fn notice() -> SecurityNotice {
        SecurityNotice {
            event_type: "lifecycle.expiry.urgent".into(),
            severity: Severity::Error,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "certificate".into(),
            subject_id: "cert-1".into(),
            label: Some("api.example.com".into()),
            occurred_at: "2026-08-30T00:00:00Z".parse().unwrap(),
            summary: "certificate expires in 18 hours".into(),
            detail: None,
            payload: json!({"remaining_seconds": 64_800, "password": "hunter2"}),
        }
    }

    #[test]
    fn the_body_is_the_array_the_endpoint_expects() {
        let body = render(&notice());
        assert_eq!(body.as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_firing_alert_has_no_end_time() {
        let alert = alert(&notice());
        assert_eq!(alert["startsAt"], json!("2026-08-30T00:00:00+00:00"));
        assert!(
            alert.get("endsAt").is_none(),
            "an ongoing condition must not look resolved",
        );
    }

    #[test]
    fn a_resolved_alert_closes_at_its_occurrence() {
        let mut settled = notice();
        settled.state = NoticeState::Resolved;
        let alert = alert(&settled);
        assert_eq!(alert["endsAt"], alert["startsAt"]);
    }

    #[test]
    fn label_names_are_valid_prometheus_identifiers() {
        let alert = alert(&notice());
        for name in alert["labels"].as_object().unwrap().keys() {
            let mut characters = name.chars();
            let first = characters.next().unwrap();
            assert!(
                first.is_ascii_alphabetic() || first == '_',
                "label {name} starts with an illegal character",
            );
            assert!(
                characters.all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "label {name} contains an illegal character",
            );
        }
    }

    #[test]
    fn severity_reaches_alertmanager_as_its_own_name() {
        for level in Severity::ALL {
            let mut at = notice();
            at.severity = level;
            assert_eq!(alert(&at)["labels"]["severity"], json!(level.as_str()));
        }
    }

    #[test]
    fn secret_shaped_payload_keys_never_reach_an_annotation() {
        let alert = alert(&notice());
        let event = &alert["annotations"]["event"];
        assert!(event.get("password").is_none());
        assert_eq!(event["remaining_seconds"], json!(64_800));
        assert!(!serde_json::to_string(&alert).unwrap().contains("hunter2"));
    }

    #[test]
    fn the_alert_key_travels_as_a_label_so_routing_can_group_on_it() {
        assert_eq!(
            alert(&notice())["labels"]["alert_key"],
            json!("lifecycle:org-1:certificate:cert-1"),
        );
    }
}
