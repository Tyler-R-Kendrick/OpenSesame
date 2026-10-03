//! Every sink a `surrogate.*` notice can reach, rendered, and searched for the
//! surrogate the refused request carried.
//!
//! The unit tests prove each fence. This proves the property those fences
//! exist for, end to end through the public API: whatever an attacker put in a
//! refused request, no field of the Alertmanager body, the `PagerDuty` event,
//! the RFC 5424 line, the serialized notice or the subscriber payload carries
//! a surrogate's text.

use chrono::{DateTime, Utc};
use opensesame_agent_events::surrogate::carries_surrogate;
use opensesame_agent_events::{
    surrogate_refusal_notice, SurrogateRefusalReport, SURROGATE_EVENT_TYPES,
};
use opensesame_security_events::render::{alertmanager, pagerduty, syslog};
use opensesame_security_events::SecurityNotice;

const SURROGATE: &str = "osr_fedcba9876543210fedcba9876543210";
const BODY: &str = "fedcba9876543210fedcba9876543210";

fn now() -> DateTime<Utc> {
    "2026-09-28T12:00:00Z".parse().unwrap()
}

/// Every place a hostile request could have put the surrogate's text, in every
/// shape ADR 0150 §7 says is inert but must still not be printed.
fn hostile_details() -> Vec<String> {
    vec![
        SURROGATE.to_string(),
        SURROGATE.to_ascii_uppercase(),
        BODY.to_string(),
        SURROGATE.replace('_', "%5F"),
        format!("Bearer {SURROGATE}"),
        format!("{SURROGATE}.attacker.example"),
        format!("attacker.example/{SURROGATE}"),
        format!("https://attacker.example/?q={SURROGATE}"),
    ]
}

fn rendered(notice: &SecurityNotice) -> Vec<String> {
    vec![
        alertmanager::render(notice).to_string(),
        pagerduty::render(notice, "routing-key").to_string(),
        syslog::render(notice, &syslog::Origin::default()),
        serde_json::to_string(notice).unwrap(),
        notice.safe_payload().to_string(),
        notice.alert_key(),
    ]
}

fn assert_clean(notice: &SecurityNotice, context: &str) {
    for sink in rendered(notice) {
        let lowered = sink.to_ascii_lowercase();
        assert!(!lowered.contains("osr_"), "{context}: {sink}");
        assert!(!lowered.contains("osr%5f"), "{context}: {sink}");
        assert!(!lowered.contains(BODY), "{context}: {sink}");
    }
}

#[test]
fn no_sink_carries_a_surrogate_from_a_hostile_detail() {
    for code in SURROGATE_EVENT_TYPES {
        for detail in hostile_details() {
            let report = SurrogateRefusalReport {
                code,
                run_id: Some("run-a"),
                provider_id: Some("github"),
                detail: Some(&detail),
                organization_id: Some("org:one"),
                occurred_at: now(),
            };
            let notice = surrogate_refusal_notice(&report).unwrap();
            assert_clean(&notice, &format!("{code} with detail {}", detail.len()));
            assert_eq!(notice.detail, None, "{code}: a hostile detail was carried");
        }
    }
}

#[test]
fn no_sink_carries_a_surrogate_that_reached_an_identifier() {
    let upper = SURROGATE.to_ascii_uppercase();
    for code in SURROGATE_EVENT_TYPES {
        let report = SurrogateRefusalReport {
            code,
            run_id: Some(SURROGATE),
            provider_id: Some(&upper),
            detail: None,
            organization_id: None,
            occurred_at: now(),
        };
        let notice = surrogate_refusal_notice(&report).unwrap();
        assert_clean(&notice, code);
    }
}

#[test]
fn a_clean_detail_reaches_every_sink_so_the_page_is_actionable() {
    let report = SurrogateRefusalReport {
        code: "surrogate.misdirected",
        run_id: Some("run-a"),
        provider_id: Some("github"),
        detail: Some("attacker.example"),
        organization_id: Some("org:one"),
        occurred_at: now(),
    };
    let notice = surrogate_refusal_notice(&report).unwrap();
    for sink in rendered(&notice).into_iter().take(3) {
        assert!(sink.contains("attacker.example"), "{sink}");
        assert!(!carries_surrogate(&sink), "{sink}");
    }
    assert_eq!(
        notice.summary,
        "a surrogate for github was sent to a host its provider does not use: attacker.example"
    );
}
