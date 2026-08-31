//! Turning a queued notice into the request one sink expects.
//!
//! The ledger stores the [`SecurityNotice`] rather than a rendered body, so the
//! same queued row can be rendered for whichever sink it is bound to, and a
//! delivery replayed after a restart produces the same request as the one that
//! failed. Rendering is pure and lives in `opensesame-security-events`; this
//! module is the thin layer that picks a renderer, decides the headers, and
//! keeps the webhook body backward compatible.

use opensesame_security_events::render::{alertmanager, pagerduty};
use opensesame_security_events::{Delivery, SecurityNotice};
use serde_json::{json, Map, Value};

/// One rendered request, minus the endpoint the hook row already carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    pub body: String,
    /// Headers beyond `content-type: application/json`.
    pub headers: Vec<(String, String)>,
}

/// The body delivered to a Standard Webhooks subscriber.
///
/// The detector's own payload at the top level, exactly where it was before the
/// security-event envelope existed, plus the envelope's four additions. Purely
/// additive: a subscriber written against the expiry feed keeps working
/// unchanged, and one written today can filter on `severity` without parsing
/// the event name.
#[must_use]
pub fn webhook_body(notice: &SecurityNotice) -> Value {
    let mut body: Map<String, Value> = match notice.safe_payload() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    body.insert("severity".into(), json!(notice.severity.as_str()));
    body.insert("state".into(), json!(notice.state.as_str()));
    body.insert("summary".into(), json!(notice.summary_text()));
    body.insert("alert_key".into(), json!(notice.alert_key()));
    Value::Object(body)
}

/// A queued delivery's stored body, which is not always a [`SecurityNotice`].
///
/// Migration 0020 carried the pre-existing delivery ledger across, and rows
/// written before it hold the detecting crate's flat payload rather than the
/// envelope. Decoding one as a notice fails, and a failure here is permanent —
/// so without this distinction every delivery in flight at upgrade time would
/// be dead-lettered instead of sent. Losing exactly the notifications somebody
/// was already waiting on is the worst moment to lose them.
#[derive(Clone, Debug, PartialEq)]
pub enum Queued {
    /// Written by this version: the shared envelope.
    Notice(Box<SecurityNotice>),
    /// Written before migration 0020: a detector's flat payload.
    Legacy(String),
}

/// Decode a queued row's stored body.
///
/// Never fails. A body that is not an envelope is treated as legacy rather
/// than as corruption: the two are indistinguishable from here, and the safe
/// reading of an ambiguous row is the one that still delivers it.
#[must_use]
pub fn decode(payload_json: &str) -> Queued {
    serde_json::from_str::<SecurityNotice>(payload_json).map_or_else(
        |_| Queued::Legacy(payload_json.to_string()),
        |notice| Queued::Notice(Box::new(notice)),
    )
}

/// Render a queued row for one sink.
///
/// A legacy row is delivered byte for byte as the pre-0020 gateway would have
/// sent it, so a subscriber sees no discontinuity across the upgrade. It is
/// only ever a webhook: the alerting sinks did not exist before the migration
/// that produced these rows, so a legacy body bound for one is a genuine
/// inconsistency rather than an upgrade artifact, and says so.
///
/// # Errors
///
/// Returns the reason when the sink needs material the row does not carry, or
/// when the body cannot be encoded. Both are permanent.
pub fn render_queued(
    delivery: Delivery,
    queued: &Queued,
    secret: Option<&str>,
) -> Result<Rendered, String> {
    match queued {
        Queued::Notice(notice) => render(delivery, notice, secret),
        Queued::Legacy(body) if delivery == Delivery::Webhook => Ok(Rendered {
            body: body.clone(),
            headers: Vec::new(),
        }),
        Queued::Legacy(_) => Err(format!(
            "a delivery queued before migration 0020 cannot be rendered for the \"{}\" sink, \
             which did not exist then",
            delivery.as_str(),
        )),
    }
}

/// Render a notice for one sink.
///
/// # Errors
///
/// Returns the reason when the sink needs material the row does not carry —
/// a `PagerDuty` routing key, in practice — or when the body cannot be
/// encoded. Both are permanent conditions: retrying an unconfigured hook
/// produces the same result forever.
pub fn render(
    delivery: Delivery,
    notice: &SecurityNotice,
    secret: Option<&str>,
) -> Result<Rendered, String> {
    match delivery {
        Delivery::Webhook => encode(&webhook_body(notice), Vec::new()),
        Delivery::Alertmanager => encode(&alertmanager::render(notice), bearer(secret)),
        Delivery::PagerDuty => {
            let routing_key = secret.ok_or_else(|| {
                "pagerduty hook has no routing key; re-register it with one".to_string()
            })?;
            encode(&pagerduty::render(notice, routing_key), Vec::new())
        }
        Delivery::Internal => {
            Err("an internal responder runs in process and is never delivered".to_string())
        }
    }
}

/// An optional bearer header for an Alertmanager behind an authenticating
/// proxy.
///
/// Alertmanager's own ingest API is unauthenticated by design, so the secret is
/// optional here where it is required for `PagerDuty`. Operators who front it
/// with a proxy store a token on the hook and get this header.
fn bearer(secret: Option<&str>) -> Vec<(String, String)> {
    secret
        .map(|token| vec![("authorization".to_string(), format!("Bearer {token}"))])
        .unwrap_or_default()
}

fn encode(body: &Value, headers: Vec<(String, String)>) -> Result<Rendered, String> {
    serde_json::to_string(body)
        .map(|body| Rendered { body, headers })
        .map_err(|error| format!("sink body could not be encoded: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_security_events::{NoticeState, Severity};

    const ROUTING_KEY: &str = "R0UT1NGK3Y";

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
            summary: "certificate api.example.com expires in 18 hours".into(),
            detail: None,
            payload: json!({
                "event_type": "lifecycle.expiry.urgent",
                "stage": "urgent",
                "subject_kind": "certificate",
                "subject_id": "cert-1",
                "remaining_seconds": 64_800,
                "secrets_returned": false,
                "password": "hunter2",
            }),
        }
    }

    #[test]
    fn the_webhook_body_keeps_every_key_the_expiry_feed_already_delivered() {
        let body = webhook_body(&notice());
        for key in [
            "event_type",
            "stage",
            "subject_kind",
            "subject_id",
            "remaining_seconds",
            "secrets_returned",
        ] {
            assert!(body.get(key).is_some(), "the feed dropped {key}");
        }
        assert_eq!(body["stage"], json!("urgent"));
    }

    #[test]
    fn the_webhook_body_adds_the_envelopes_own_fields() {
        let body = webhook_body(&notice());
        assert_eq!(body["severity"], json!("error"));
        assert_eq!(body["state"], json!("firing"));
        assert_eq!(
            body["alert_key"],
            json!("lifecycle:org-1:certificate:cert-1")
        );
        assert!(body["summary"]
            .as_str()
            .unwrap()
            .contains("api.example.com"));
    }

    #[test]
    fn no_sink_ever_renders_a_secret_shaped_key() {
        for delivery in [
            Delivery::Webhook,
            Delivery::Alertmanager,
            Delivery::PagerDuty,
        ] {
            let rendered = render(delivery, &notice(), Some(ROUTING_KEY)).unwrap();
            assert!(
                !rendered.body.contains("hunter2"),
                "{delivery:?} leaked a value: {}",
                rendered.body,
            );
            assert!(!rendered.body.contains("\"password\""), "{delivery:?}");
        }
    }

    #[test]
    fn pagerduty_refuses_to_render_without_a_routing_key() {
        let error = render(Delivery::PagerDuty, &notice(), None).unwrap_err();
        assert!(error.contains("routing key"), "{error}");
    }

    #[test]
    fn alertmanager_renders_without_a_secret_and_adds_a_bearer_with_one() {
        let plain = render(Delivery::Alertmanager, &notice(), None).unwrap();
        assert!(plain.headers.is_empty());
        assert!(plain.body.starts_with('['), "the v2 API takes an array");

        let proxied = render(Delivery::Alertmanager, &notice(), Some("tok")).unwrap();
        assert_eq!(
            proxied.headers,
            vec![("authorization".to_string(), "Bearer tok".to_string())],
        );
    }

    #[test]
    fn an_internal_responder_is_never_rendered_for_the_wire() {
        let error = render(Delivery::Internal, &notice(), None).unwrap_err();
        assert!(error.contains("in process"), "{error}");
    }

    #[test]
    fn a_pagerduty_body_carries_the_routing_key_and_a_trigger() {
        let rendered = render(Delivery::PagerDuty, &notice(), Some(ROUTING_KEY)).unwrap();
        let body: Value = serde_json::from_str(&rendered.body).unwrap();
        assert_eq!(body["routing_key"], json!(ROUTING_KEY));
        assert_eq!(body["event_action"], json!("trigger"));
    }

    #[test]
    fn a_resolved_notice_reaches_pagerduty_as_a_resolve() {
        let mut settled = notice();
        settled.state = NoticeState::Resolved;
        let rendered = render(Delivery::PagerDuty, &settled, Some(ROUTING_KEY)).unwrap();
        let body: Value = serde_json::from_str(&rendered.body).unwrap();
        assert_eq!(body["event_action"], json!("resolve"));
    }

    #[test]
    fn a_notice_whose_payload_is_not_an_object_still_renders_a_usable_body() {
        let mut odd = notice();
        odd.payload = json!("nonsense");
        let body = webhook_body(&odd);
        assert_eq!(body["severity"], json!("error"));
        assert!(body.get("stage").is_none());
    }
    /// Exactly what the pre-0020 gateway stored: `LifecycleEvent::payload()`.
    const LEGACY_BODY: &str = r#"{"event_type":"lifecycle.renewal.due","stage":"renewal","subject_kind":"certificate","subject_id":"cert-1","organization_id":"org-1","expires_at":"2026-09-06T00:00:00+00:00","occurred_at":"2026-09-05T00:00:00+00:00","remaining_seconds":86400,"renew_before_seconds":86400,"auto_respond":true,"secrets_returned":false}"#;

    #[test]
    fn a_row_written_by_this_version_decodes_as_an_envelope() {
        let encoded = serde_json::to_string(&notice()).unwrap();
        match decode(&encoded) {
            Queued::Notice(decoded) => assert_eq!(*decoded, notice()),
            Queued::Legacy(body) => panic!("an envelope was read as legacy: {body}"),
        }
    }

    #[test]
    fn a_row_queued_before_the_migration_is_recognised_rather_than_rejected() {
        assert!(
            serde_json::from_str::<SecurityNotice>(LEGACY_BODY).is_err(),
            "the premise of this test is that the old shape is not an envelope",
        );
        assert_eq!(decode(LEGACY_BODY), Queued::Legacy(LEGACY_BODY.to_string()));
    }

    #[test]
    fn a_legacy_row_is_delivered_byte_for_byte_as_it_was_written() {
        // The upgrade must be invisible to a subscriber who was already
        // waiting on this delivery: same bytes, same signature input.
        let rendered =
            render_queued(Delivery::Webhook, &decode(LEGACY_BODY), Some("whsec_x")).unwrap();
        assert_eq!(rendered.body, LEGACY_BODY);
        assert!(rendered.headers.is_empty());
    }

    #[test]
    fn a_legacy_row_bound_for_an_alerting_sink_says_why_it_cannot_be_rendered() {
        for delivery in [Delivery::Alertmanager, Delivery::PagerDuty] {
            let error = render_queued(delivery, &decode(LEGACY_BODY), Some("k")).unwrap_err();
            assert!(error.contains("0020"), "{delivery:?}: {error}");
        }
    }

    #[test]
    fn an_envelope_row_still_renders_for_every_sink() {
        let queued = decode(&serde_json::to_string(&notice()).unwrap());
        for delivery in [
            Delivery::Webhook,
            Delivery::Alertmanager,
            Delivery::PagerDuty,
        ] {
            let rendered = render_queued(delivery, &queued, Some("R0UT1NGK3Y")).unwrap();
            assert!(!rendered.body.is_empty(), "{delivery:?}");
            assert!(!rendered.body.contains("hunter2"), "{delivery:?}");
        }
    }
}
