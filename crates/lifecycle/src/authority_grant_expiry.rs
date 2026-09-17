//! INV-GA-05: an authority grant's deadline reaches the lifecycle feed.
//!
//! Auth-path denial is `fenced_authority`'s `expires_at` clause (ADR 0121);
//! this module only proves the feed half — notifications are not revocation.

use chrono::{DateTime, Utc};

use crate::evaluate::{evaluate, should_respond, Watermarks};
use crate::event::EVENT_EXPIRY_EXPIRED;
use crate::subject::{ExpirySubject, SubjectKind};

fn at(raw: &str) -> DateTime<Utc> {
    raw.parse().unwrap()
}

#[test]
fn authority_grant_expiry_reaches_the_lifecycle_feed() {
    let subject = ExpirySubject {
        kind: SubjectKind::AuthorityGrant,
        subject_id: "grant:fixture".into(),
        organization_id: "org:fixture".into(),
        expires_at: at("2026-09-01T00:00:00Z"),
        renew_before_seconds: Some(3_600),
        auto_respond: true,
        alerting: true,
        label: None,
    };
    assert!(!subject.kind.renewable());
    let now = at("2026-09-01T00:01:00Z");
    let events = evaluate(&subject, Watermarks::default(), now);
    assert!(
        events
            .iter()
            .any(|event| event.event_type == EVENT_EXPIRY_EXPIRED),
        "expected {EVENT_EXPIRY_EXPIRED}, got {events:?}"
    );
    for event in &events {
        assert!(
            !should_respond(event),
            "AuthorityGrant must never auto-respond ({})",
            event.event_type
        );
    }
}
