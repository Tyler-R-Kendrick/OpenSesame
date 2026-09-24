use super::*;
use crate::subject::SubjectKind;

fn at(raw: &str) -> DateTime<Utc> {
    raw.parse().unwrap()
}

fn grant_subject(auto_respond: bool) -> ExpirySubject {
    ExpirySubject {
        kind: SubjectKind::SessionGrant,
        subject_id: "sgrant-1".into(),
        organization_id: "org-1".into(),
        expires_at: at("2026-09-01T00:00:00Z"),
        renew_before_seconds: None,
        auto_respond,
        alerting: true,
        label: None,
    }
}

#[test]
fn a_session_grant_is_never_auto_renewed_even_when_the_flag_says_so() {
    // The point of putting renewability on the kind: a subject built with
    // `auto_respond: true` — by mistake, or by copying a row from a
    // certificate — must still not cause the platform to extend one
    // human's reach into another's vault (ADR 0079).
    let subject = grant_subject(true);
    let now = at("2026-08-31T00:00:00Z");
    let events = evaluate(&subject, Watermarks::default(), now);

    assert!(!events.is_empty(), "the ladder still narrates");
    for event in &events {
        assert!(
            !should_respond(event),
            "{} must never be acted on automatically",
            event.event_type
        );
    }
}

#[test]
fn a_session_grant_still_warns_on_every_rung_it_crosses() {
    // Refusing to act is not refusing to tell. Somebody whose access
    // lapses in an hour is exactly who the ladder exists for.
    let subject = grant_subject(false);
    let now = at("2026-08-31T23:30:00Z");
    let events = evaluate(&subject, Watermarks::default(), now);
    assert!(
        events.iter().any(LifecycleEvent::is_ladder_event),
        "expected at least one ladder event, got {events:?}"
    );
}

#[test]
fn a_renewable_kind_is_unaffected_by_the_new_rule() {
    // The regression that would matter: certificates must still renew.
    let mut subject = grant_subject(true);
    subject.kind = SubjectKind::Certificate;
    subject.subject_id = "cert-1".into();
    let now = at("2026-08-31T23:30:00Z");
    let events = evaluate(&subject, Watermarks::default(), now);
    assert!(
        events.iter().any(should_respond),
        "a certificate on an actionable rung should still be acted on"
    );
}
