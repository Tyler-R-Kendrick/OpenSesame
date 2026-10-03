//! One test per way a refusal's text could carry a surrogate onto the feed, and
//! the vocabulary pins that make drift a test failure.

use super::*;

const SURROGATE: &str = "osr_0123456789abcdef0123456789abcdef";

fn now() -> DateTime<Utc> {
    "2026-09-28T00:00:00Z".parse().unwrap()
}

fn report(code: &str) -> SurrogateRefusalReport<'_> {
    SurrogateRefusalReport {
        code,
        run_id: Some("run-a"),
        provider_id: Some("github"),
        detail: None,
        organization_id: Some("org:one"),
        occurred_at: now(),
    }
}

fn with_detail<'a>(code: &'a str, detail: &'a str) -> SurrogateEvent {
    let mut report = report(code);
    report.detail = Some(detail);
    SurrogateEvent::from_report(&report).unwrap()
}

fn assert_withheld(event: &SurrogateEvent, field: &str) {
    assert!(event.withheld().contains(&field), "{field} was carried");
    let notice = event.notice();
    let rendered = serde_json::to_string(&notice).unwrap().to_ascii_lowercase();
    assert!(!rendered.contains("osr_"), "{rendered}");
    assert!(!rendered.contains("0123456789abcdef0123456789abcdef"));
}

#[test]
fn event_names_are_frozen() {
    assert_eq!(
        SURROGATE_EVENT_TYPES,
        [
            "surrogate.ambiguous",
            "surrogate.unknown",
            "surrogate.revoked",
            "surrogate.expired",
            "surrogate.foreign_caller",
            "surrogate.misdirected",
            "surrogate.cleartext",
            "surrogate.misplaced",
            "surrogate.out_of_scope",
        ]
    );
    assert_eq!(SURROGATE_EVENT_WILDCARD, "surrogate.*");
    assert_eq!(SURROGATE_SUBJECT_KINDS, ["agent_run", "surrogate_proxy"]);
}

#[test]
fn every_refusal_code_maps_onto_its_own_name_and_back() {
    assert_eq!(SurrogateFence::ALL.len(), SURROGATE_EVENT_TYPES.len());
    for (fence, name) in SurrogateFence::ALL.iter().zip(SURROGATE_EVENT_TYPES) {
        assert_eq!(fence.event_type(), *name);
        assert_eq!(SurrogateFence::parse(name), Ok(*fence));
        assert!(is_surrogate_event_type(name));
        let notice = surrogate_refusal_notice(&report(name)).unwrap();
        assert_eq!(notice.event_type, *name);
        assert_eq!(notice.family(), "surrogate");
        assert_eq!(notice.severity, fence.severity());
        assert_eq!(notice.payload["fence"], json!(fence.as_str()));
    }
}

#[test]
fn an_unknown_code_is_refused_rather_than_passed_through() {
    for code in [
        "surrogate.exploded",
        "SURROGATE.MISDIRECTED",
        " surrogate.misdirected",
        "misdirected",
        "agent.run.blocked",
        "",
    ] {
        assert_eq!(
            surrogate_refusal_notice(&report(code)),
            Err(SurrogateNoticeError::UnknownCode),
            "{code:?} was published",
        );
    }
}

#[test]
fn a_surrogate_passed_as_the_code_is_not_echoed_by_the_error() {
    let error = surrogate_refusal_notice(&report(SURROGATE)).unwrap_err();
    assert!(!error.to_string().contains("osr_"));
    assert!(!format!("{error:?}").contains("osr_"));
}

#[test]
fn the_severities_follow_how_strongly_a_copy_is_loose() {
    use SurrogateFence::{
        Ambiguous, Cleartext, Expired, ForeignCaller, Misdirected, Misplaced, OutOfScope, Revoked,
        Unknown,
    };
    for fence in [Misdirected, ForeignCaller, Revoked] {
        assert_eq!(fence.severity(), Severity::Error, "{fence:?}");
    }
    for fence in [Misplaced, OutOfScope, Ambiguous, Cleartext] {
        assert_eq!(fence.severity(), Severity::Warning, "{fence:?}");
    }
    for fence in [Unknown, Expired] {
        assert_eq!(fence.severity(), Severity::Info, "{fence:?}");
    }
    // Critical means a credential is exposed; a refused surrogate is the case
    // where the fence held.
    assert!(SurrogateFence::ALL
        .iter()
        .all(|fence| fence.severity() != Severity::Critical));
}

#[test]
fn a_surrogate_in_the_detail_is_withheld() {
    let event = with_detail(EVENT_SURROGATE_MISPLACED, SURROGATE);
    assert_withheld(&event, "detail");
}

#[test]
fn a_surrogate_inside_a_host_shaped_detail_is_withheld() {
    let host = format!("{SURROGATE}.attacker.example");
    assert_withheld(&with_detail(EVENT_SURROGATE_MISDIRECTED, &host), "detail");
}

#[test]
fn an_uppercased_surrogate_in_the_detail_is_withheld() {
    let upper = SURROGATE.to_ascii_uppercase();
    assert_withheld(&with_detail(EVENT_SURROGATE_MISPLACED, &upper), "detail");
}

#[test]
fn a_surrogate_body_without_its_marker_in_the_detail_is_withheld() {
    let body = SURROGATE.trim_start_matches("osr_");
    assert_withheld(&with_detail(EVENT_SURROGATE_MISDIRECTED, body), "detail");
}

#[test]
fn a_percent_encoded_marker_in_the_detail_is_withheld() {
    let encoded = SURROGATE.replace('_', "%5F");
    assert_withheld(&with_detail(EVENT_SURROGATE_MISPLACED, &encoded), "detail");
}

#[test]
fn a_header_value_passed_as_the_detail_is_withheld() {
    let value = format!("Bearer {SURROGATE}");
    assert_withheld(&with_detail(EVENT_SURROGATE_MISPLACED, &value), "detail");
}

#[test]
fn a_url_passed_as_the_detail_is_withheld() {
    let url = "https://evil.example/collect?k=v";
    let event = with_detail(EVENT_SURROGATE_MISDIRECTED, url);
    assert!(event.withheld().contains(&"detail"));
    assert_eq!(event.notice().detail, None);
}

#[test]
fn an_overlong_detail_is_withheld_rather_than_truncated() {
    let long = format!("{}.example", "a".repeat(MAX_SURROGATE_DETAIL_CHARS));
    let event = with_detail(EVENT_SURROGATE_MISDIRECTED, &long);
    assert!(event.withheld().contains(&"detail"));
    assert_eq!(event.notice().detail, None);
}

#[test]
fn a_host_or_a_site_name_is_carried_as_it_reads() {
    for detail in [
        "evil.example",
        "api.github.com:8443",
        "[2001:db8::1]:443",
        "x-api-key",
        "body",
    ] {
        let event = with_detail(EVENT_SURROGATE_MISDIRECTED, detail);
        assert!(event.withheld().is_empty(), "{detail} was withheld");
        let notice = event.notice();
        assert_eq!(notice.detail.as_deref(), Some(detail));
        assert!(notice.summary.ends_with(&format!(": {detail}")));
    }
}

#[test]
fn the_tripwire_survives_a_withheld_detail() {
    let notice = with_detail(EVENT_SURROGATE_MISDIRECTED, SURROGATE).notice();
    assert_eq!(notice.event_type, EVENT_SURROGATE_MISDIRECTED);
    assert_eq!(notice.severity, Severity::Error);
    assert_eq!(notice.payload["withheld"], json!(["detail"]));
}

#[test]
fn a_surrogate_in_the_run_id_does_not_become_the_subject() {
    let mut leaky = report(EVENT_SURROGATE_FOREIGN_CALLER);
    leaky.run_id = Some(SURROGATE);
    let event = SurrogateEvent::from_report(&leaky).unwrap();
    assert_withheld(&event, "run_id");
    let notice = event.notice();
    assert_eq!(notice.subject_kind, SURROGATE_PROXY_SUBJECT_KIND);
    assert_eq!(notice.subject_id, UNATTRIBUTED_SUBJECT);
}

#[test]
fn a_surrogate_in_the_provider_id_never_becomes_the_label() {
    let mut leaky = report(EVENT_SURROGATE_MISDIRECTED);
    leaky.provider_id = Some(SURROGATE);
    let event = SurrogateEvent::from_report(&leaky).unwrap();
    assert_withheld(&event, "provider_id");
    assert_eq!(event.notice().label, None);
}

#[test]
fn a_surrogate_in_the_organization_is_refused() {
    let mut leaky = report(EVENT_SURROGATE_MISDIRECTED);
    leaky.organization_id = Some(SURROGATE);
    assert_eq!(
        SurrogateEvent::from_report(&leaky),
        Err(SurrogateNoticeError::InvalidOrganization)
    );
}

#[test]
fn a_simple_uuid_run_id_is_still_attributed() {
    // Identifiers come from the ledger's own issue record, so a 32-digit run id
    // is a run, not a leaked surrogate body.
    let mut uuid = report(EVENT_SURROGATE_REVOKED);
    uuid.run_id = Some("0190f3a2b4c47d8e9f00112233445566");
    let notice = surrogate_refusal_notice(&uuid).unwrap();
    assert_eq!(notice.subject_kind, SURROGATE_RUN_SUBJECT_KIND);
    assert_eq!(notice.subject_id, "0190f3a2b4c47d8e9f00112233445566");
}

#[test]
fn a_known_run_is_the_subject_and_every_tripwire_it_trips_is_one_incident() {
    let misdirected = surrogate_refusal_notice(&report(EVENT_SURROGATE_MISDIRECTED)).unwrap();
    let misplaced = surrogate_refusal_notice(&report(EVENT_SURROGATE_MISPLACED)).unwrap();
    assert_eq!(misdirected.subject_kind, "agent_run");
    assert_eq!(misdirected.subject_id, "run-a");
    assert_eq!(misdirected.label.as_deref(), Some("github"));
    assert_eq!(misdirected.alert_key(), misplaced.alert_key());
    assert_eq!(misdirected.alert_key(), "surrogate:org:one:agent_run:run-a");
}

#[test]
fn an_unattributed_refusal_reports_under_the_broker() {
    let bare = SurrogateRefusalReport {
        code: EVENT_SURROGATE_UNKNOWN,
        run_id: None,
        provider_id: None,
        detail: None,
        organization_id: None,
        occurred_at: now(),
    };
    let notice = surrogate_refusal_notice(&bare).unwrap();
    assert_eq!(notice.subject_kind, "surrogate_proxy");
    assert_eq!(notice.subject_id, "unattributed");
    assert_eq!(notice.organization_id, LOCAL_ORGANIZATION);
    assert_eq!(
        notice.summary,
        "a request carried a surrogate this broker never issued"
    );
}

#[test]
fn a_tripwire_never_resolves_itself() {
    for name in SURROGATE_EVENT_TYPES {
        let notice = surrogate_refusal_notice(&report(name)).unwrap();
        assert_eq!(notice.state, NoticeState::Firing, "{name}");
    }
}

#[test]
fn the_shared_filter_reads_this_family_without_being_taught_it() {
    use opensesame_security_events::filter;
    let known: Vec<&str> = SURROGATE_EVENT_TYPES.to_vec();
    let wildcard = [SURROGATE_EVENT_WILDCARD.to_string()];
    assert!(filter::matches(&wildcard, EVENT_SURROGATE_MISDIRECTED));
    assert!(!filter::matches(
        &["agent.*".into()],
        EVENT_SURROGATE_MISDIRECTED
    ));
    assert!(filter::is_valid(&wildcard, &known));
    assert!(!filter::is_valid(&["surrogate.exploded".into()], &known));
}

#[test]
fn the_payload_is_value_blind_and_survives_the_audit_redactor() {
    let event = with_detail(EVENT_SURROGATE_MISDIRECTED, "evil.example");
    let notice = event.notice();
    assert_eq!(notice.safe_payload(), event.payload());
    let payload = event.payload();
    let object = payload.as_object().unwrap();
    assert_eq!(object["surrogate_included"], json!(false));
    for key in object.keys() {
        for forbidden in [
            "value",
            "token",
            "secret",
            "password",
            "authorization",
            "cookie",
            "user_code",
            "device_code",
            "refresh",
            "bearer",
        ] {
            assert!(!key.contains(forbidden), "`{key}` would be redacted");
        }
    }
}

#[test]
fn an_unvetted_report_does_not_print_its_text() {
    let mut leaky = report(EVENT_SURROGATE_MISPLACED);
    leaky.detail = Some(SURROGATE);
    leaky.run_id = Some(SURROGATE);
    let printed = format!("{leaky:?}");
    assert!(!printed.contains("osr_"), "{printed}");
    assert!(printed.contains("Misplaced"));
    let mut coded = report(SURROGATE);
    coded.detail = None;
    assert!(!format!("{coded:?}").contains("osr_"));
}
