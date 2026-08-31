//! Turning a queued notice into the request one sink expects.
//!
//! The ledger stores the [`SecurityNotice`] rather than a rendered body, so the
//! same queued row can be rendered for whichever sink it is bound to, and a
//! delivery replayed after a restart produces the same request as the one that
//! failed. Rendering is pure and lives in `opensesame-security-events`; this
//! module is the thin layer that picks a renderer, decides the headers, and
//! keeps the webhook body backward compatible.

use chrono::Utc;
use opensesame_agent_events::AgentEvent;
use opensesame_security_events::render::{alertmanager, pagerduty};
use opensesame_security_events::{Delivery, SecurityNotice};
use serde_json::{json, Map, Value};

/// Everything an A2H intent needs that a notice does not carry.
///
/// Passed through rather than read from the environment here so rendering
/// stays pure and testable: the delivery worker knows the deployment's public
/// URL and the row's id, and this module knows the protocol.
pub struct A2hContext<'a> {
    pub agent_id: &'a str,
    pub callback_url: &'a str,
    pub attach_url: &'a str,
    /// The ledger row's id, used as both the A2H `interaction_id` and its
    /// `message_id`. The ledger is at-least-once by design and the spec makes
    /// `message_id` the idempotency key, so a retry of the same row is
    /// deduplicated at the gateway rather than sending a second SMS to
    /// somebody who already got one.
    pub delivery_id: &'a str,
}

/// One rendered request, minus the endpoint the hook row already carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    pub body: String,
    /// Headers beyond `content-type: application/json`.
    pub headers: Vec<(String, String)>,
    /// Appended to the hook's endpoint. Empty for every sink whose stored URL
    /// is the full destination; `/v1/intent` for A2H, whose row holds a gateway
    /// *base* URL because the same gateway also serves `/.well-known/a2h` and
    /// `/v1/status/{id}`.
    pub path: &'static str,
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
            path: "",
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
        // Handled by `render_a2h`, which needs deployment context a notice does
        // not carry. Reaching here means a caller took the wrong branch.
        Delivery::A2h => Err("an a2h delivery is rendered with its own context".to_string()),
    }
}

/// Render a notice as an A2H intent.
///
/// Separate from [`render`] because A2H is the one sink whose audience is a
/// *person*, which costs it two things a notice alone cannot supply: somebody
/// to reach, and somewhere to send them.
///
/// Only the `agent.*` family carries an owner principal, so only it can be
/// rendered. That is a refusal rather than a silent skip: a lifecycle or breach
/// notice queued against an A2H hook has nobody to address, and settling the
/// row quietly would leave an operator with a subscription that looks live and
/// never sends. Registration refuses the same shape up front, so reaching this
/// means a hook was narrowed after rows were already queued.
///
/// # Errors
///
/// Returns the reason when the notice names nobody to reach or cannot be
/// encoded. Both are permanent: retrying changes neither.
pub fn render_a2h(
    notice: &SecurityNotice,
    secret: Option<&str>,
    context: &A2hContext<'_>,
) -> Result<Rendered, String> {
    let secret = secret
        .ok_or_else(|| "a2h hook has no callback secret; re-register it with one".to_string())?;
    let event = AgentEvent::from_payload(&notice.payload).ok_or_else(|| {
        format!(
            "an a2h delivery needs somebody to reach, and \"{}\" names no run owner",
            notice.event_type,
        )
    })?;
    let intent = opensesame_a2h::message_for(
        &event,
        &opensesame_a2h::IntentContext {
            agent_id: context.agent_id,
            // Left unset on purpose: choosing the channel is the gateway's job,
            // and it is the reason to speak this protocol rather than five APIs.
            channel: None,
            callback: Some(opensesame_a2h::CallbackConfig {
                url: context.callback_url.to_string(),
                secret: secret.to_string(),
            }),
            attach_url: Some(context.attach_url),
            max_ttl_sec: None,
        },
        Utc::now(),
        context.delivery_id,
        context.delivery_id,
    );
    encode_at(
        &serde_json::to_value(&intent)
            .map_err(|error| format!("a2h intent could not be encoded: {error}"))?,
        Vec::new(),
        "/v1/intent",
    )
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
    encode_at(body, headers, "")
}

fn encode_at(
    body: &Value,
    headers: Vec<(String, String)>,
    path: &'static str,
) -> Result<Rendered, String> {
    serde_json::to_string(body)
        .map(|body| Rendered {
            body,
            headers,
            path,
        })
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
    fn a2h_context() -> A2hContext<'static> {
        A2hContext {
            agent_id: "did:web:host.example",
            callback_url: "https://host.example/api/v1/a2h/callback",
            attach_url: "https://pages.example/runs?origin=https%3A%2F%2Fexample.com",
            delivery_id: "secd_1",
        }
    }

    fn blocked_run_notice() -> SecurityNotice {
        use opensesame_agent_events::{AgentEvent, AgentPhase, AgentRun};
        let now: chrono::DateTime<chrono::Utc> = "2026-08-30T00:00:00Z".parse().unwrap();
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
            now,
            now + chrono::Duration::seconds(3_600),
            Some("step-up challenge"),
        )
        .unwrap()
        .notice()
    }

    #[test]
    fn an_a2h_intent_posts_to_the_gateways_intent_path() {
        // The row holds a gateway *base* URL, because the same gateway serves
        // /.well-known/a2h and /v1/status/{id} too.
        let rendered = render_a2h(&blocked_run_notice(), Some("whsec_x"), &a2h_context()).unwrap();
        assert_eq!(rendered.path, "/v1/intent");
        for other in [
            Delivery::Webhook,
            Delivery::Alertmanager,
            Delivery::PagerDuty,
        ] {
            assert_eq!(render(other, &notice(), Some("key")).unwrap().path, "");
        }
    }

    #[test]
    fn the_ledger_row_id_is_the_idempotency_key() {
        // The ledger is at-least-once by design and A2H makes message_id the
        // idempotency key, so a retry of one row is one text, not two.
        let rendered = render_a2h(&blocked_run_notice(), Some("whsec_x"), &a2h_context()).unwrap();
        let body: Value = serde_json::from_str(&rendered.body).unwrap();
        assert_eq!(body["message_id"], json!("secd_1"));
        assert_eq!(body["interaction_id"], json!("secd_1"));
        assert_eq!(body["principal_id"], json!("principal:alice"));
        // The wire spells it `type`, per A2H v1.0.
        assert_eq!(body["type"], json!("ESCALATE"));
    }

    #[test]
    fn a_notice_that_names_nobody_is_refused_with_a_reason() {
        // A lifecycle or breach notice has no run owner, so there is nobody to
        // text. Settling the row quietly would leave an operator with a
        // subscription that looks live and never sends.
        let refusal = render_a2h(&notice(), Some("whsec_x"), &a2h_context()).unwrap_err();
        assert!(refusal.contains("names no run owner"), "{refusal}");
    }

    #[test]
    fn an_a2h_hook_without_its_callback_secret_is_refused() {
        // The secret runs in both directions: we send it, and the gateway signs
        // the person's reply with it. Without one we could not tell a real
        // reply from a forged cancel.
        let refusal = render_a2h(&blocked_run_notice(), None, &a2h_context()).unwrap_err();
        assert!(refusal.contains("callback secret"), "{refusal}");
    }

    #[test]
    fn the_generic_renderer_refuses_a2h_rather_than_guessing() {
        let refusal = render(Delivery::A2h, &blocked_run_notice(), Some("whsec_x")).unwrap_err();
        assert!(refusal.contains("own context"), "{refusal}");
    }
}
