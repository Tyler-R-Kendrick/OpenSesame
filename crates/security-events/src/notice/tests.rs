use super::*;
use serde_json::json;

pub(crate) fn notice() -> SecurityNotice {
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
        payload: json!({"remaining_seconds": 64_800, "secrets_returned": false}),
    }
}

#[test]
fn the_family_is_the_first_event_segment() {
    assert_eq!(notice().family(), "lifecycle");
    let mut breach = notice();
    breach.event_type = "breach.password.compromised".into();
    assert_eq!(breach.family(), "breach");
}

#[test]
fn an_event_type_without_a_dot_is_its_own_family() {
    let mut odd = notice();
    odd.event_type = "standalone".into();
    assert_eq!(odd.family(), "standalone");
}

#[test]
fn a_short_alert_key_is_left_exactly_as_it_reads() {
    assert_eq!(notice().alert_key(), "lifecycle:org-1:certificate:cert-1");
}

#[test]
fn a_long_alert_key_is_bounded_to_what_pagerduty_accepts() {
    let mut long = notice();
    long.subject_id = "p".repeat(400);
    let key = long.alert_key();
    assert_eq!(key.chars().count(), MAX_ALERT_KEY_CHARS);
}

#[test]
fn two_long_subjects_sharing_a_prefix_stay_separate_incidents() {
    let mut first = notice();
    first.subject_id = format!("{}/alpha", "p".repeat(400));
    let mut second = notice();
    second.subject_id = format!("{}/beta", "p".repeat(400));
    assert_ne!(
        first.alert_key(),
        second.alert_key(),
        "truncation must not merge two exposed secrets into one page",
    );
}

#[test]
fn a_bounded_alert_key_is_stable_across_calls() {
    let mut long = notice();
    long.subject_id = "p".repeat(400);
    assert_eq!(long.alert_key(), long.alert_key());
}

#[test]
fn a_bounded_alert_key_still_resolves_the_alert_it_opened() {
    let mut firing = notice();
    firing.subject_id = "p".repeat(400);
    let mut resolved = firing.clone();
    resolved.event_type = "lifecycle.renewal.succeeded".into();
    resolved.state = NoticeState::Resolved;
    assert_eq!(firing.alert_key(), resolved.alert_key());
}

#[test]
fn one_subject_keeps_one_alert_identity_across_rungs() {
    let mut urgent = notice();
    urgent.event_type = "lifecycle.expiry.urgent".into();
    let mut renewed = notice();
    renewed.event_type = "lifecycle.renewal.succeeded".into();
    renewed.state = NoticeState::Resolved;
    assert_eq!(
        urgent.alert_key(),
        renewed.alert_key(),
        "a renewal must close the page its expiry opened",
    );
}

#[test]
fn different_subjects_never_share_an_alert_identity() {
    let first = notice();
    let mut second = notice();
    second.subject_id = "cert-2".into();
    assert_ne!(first.alert_key(), second.alert_key());
}

#[test]
fn a_breach_and_an_expiry_on_one_subject_are_separate_alerts() {
    let expiry = notice();
    let mut breach = notice();
    breach.event_type = "breach.password.compromised".into();
    assert_ne!(
        expiry.alert_key(),
        breach.alert_key(),
        "renewing a certificate must not resolve a breach finding",
    );
}

#[test]
fn secret_shaped_payload_keys_are_stripped() {
    let mut leaky = notice();
    leaky.payload = json!({
        "remaining_seconds": 10,
        "password": "hunter2",
        "API_KEY": "sk-live",
        "refresh_token": "rt",
        "secrets_returned": false,
    });
    let safe = leaky.safe_payload();
    let object = safe.as_object().unwrap();
    assert_eq!(object.len(), 2);
    assert!(object.contains_key("remaining_seconds"));
    assert!(
        object.contains_key("secrets_returned"),
        "the non-disclosure marker is the one 'secret'-shaped key that stays",
    );
}

#[test]
fn nested_secret_keys_and_secret_values_do_not_survive_the_payload() {
    let mut nested = notice();
    nested.payload = json!({
        "remaining_seconds": 10,
        "provider": {"name": "acme", "api_key": "sk-live", "note": "retry https://h.example/x#token=abc123"},
        "steps": [{"password": "p", "ok": true}],
    });
    let safe = nested.safe_payload().to_string();
    for leaked in ["sk-live", "abc123", "\"p\""] {
        assert!(!safe.contains(leaked), "{leaked} survived: {safe}");
    }
    assert!(safe.contains("acme") && safe.contains("remaining_seconds"));
}

#[test]
fn free_text_is_scrubbed_before_it_is_bounded_and_sent() {
    let mut leaky = notice();
    leaky.summary =
        "delivery failed: https://app.example/claim#token=osc_clm_AbC.s3cr3tpart".into();
    leaky.label = Some("hook postgres://app:pw0rd@db/x".into());
    leaky.detail = Some("Authorization: Bearer abc.def.ghi".into());
    leaky.subject_id = "https://feed.example/x?api_key=k123".into();
    for text in [
        leaky.summary_text(),
        leaky.label_text().unwrap(),
        leaky.detail_text().unwrap(),
        leaky.subject_id_text(),
    ] {
        for leaked in ["osc_clm_", "s3cr3tpart", "pw0rd", "abc.def.ghi", "k123"] {
            assert!(!text.contains(leaked), "{leaked} survived: {text}");
        }
    }
}

#[test]
fn a_scrubbed_notice_is_clean_idempotent_and_keeps_its_identity_fields() {
    let mut leaky = notice();
    leaky.summary = "failed: password=hunter2".into();
    leaky.payload = json!({"detail": "token=abc123", "remaining_seconds": 3});
    let once = leaky.scrubbed();
    assert_eq!(once.scrubbed(), once);
    assert!(!serde_json::to_string(&once).unwrap().contains("hunter2"));
    assert_eq!(once.event_type, leaky.event_type);
    assert_eq!(once.organization_id, leaky.organization_id);
    assert_eq!(once.alert_key(), leaky.alert_key());
}

#[test]
fn a_payload_that_is_not_an_object_is_dropped_entirely() {
    let mut odd = notice();
    odd.payload = json!("hunter2");
    assert_eq!(odd.safe_payload(), json!({}));
}

#[test]
fn long_text_is_bounded_before_it_reaches_a_sink() {
    let mut long = notice();
    long.summary = "s".repeat(MAX_SUMMARY_CHARS * 2);
    long.label = Some("l".repeat(MAX_LABEL_CHARS * 2));
    long.detail = Some("d".repeat(MAX_DETAIL_CHARS * 2));
    assert_eq!(long.summary_text().chars().count(), MAX_SUMMARY_CHARS);
    assert_eq!(long.label_text().unwrap().chars().count(), MAX_LABEL_CHARS);
    assert_eq!(
        long.detail_text().unwrap().chars().count(),
        MAX_DETAIL_CHARS
    );
}

#[test]
fn an_alert_key_carries_only_metadata() {
    let key = notice().alert_key();
    assert_eq!(key, "lifecycle:org-1:certificate:cert-1");
}
