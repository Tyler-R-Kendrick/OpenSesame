//! The `agent.*` family's structural tests, kept beside the crate rather than
//! inline so `lib.rs` stays the vocabulary and nothing else.

use super::*;

fn now() -> DateTime<Utc> {
    "2026-08-31T00:00:00Z".parse().unwrap()
}

fn run() -> AgentRun {
    AgentRun {
        run_id: "run:1".into(),
        job_id: "job:1".into(),
        organization_id: "org:one".into(),
        owner_principal_id: "principal:alice".into(),
        origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: "agent_driving".into(),
    }
}

#[test]
fn event_names_are_frozen() {
    assert_eq!(
        AGENT_EVENT_TYPES,
        [
            "agent.run.started",
            "agent.run.blocked",
            "agent.control.awaiting_human",
            "agent.control.granted",
            "agent.control.released",
            "agent.run.resumed",
            "agent.run.completed",
            "agent.run.failed",
        ]
    );
    assert_eq!(EVENT_WILDCARD, "agent.*");
}

#[test]
fn every_phase_has_a_registered_event_name() {
    for phase in [
        AgentPhase::Started,
        AgentPhase::Blocked,
        AgentPhase::AwaitingHuman,
        AgentPhase::ControlGranted,
        AgentPhase::ControlReleased,
        AgentPhase::Resumed,
        AgentPhase::Completed,
        AgentPhase::Failed,
    ] {
        assert!(
            is_agent_event_type(phase.event_type()),
            "{phase:?} publishes under an unregistered name"
        );
    }
}

#[test]
fn an_escalation_cannot_be_built_without_a_deadline() {
    // The whole point: a blocked run is holding a live authenticated
    // session open while it waits, so there is no such thing as asking a
    // person to act on it with no clock.
    assert_eq!(
        AgentEvent::reporting(run(), AgentPhase::Blocked, now(), None),
        Err(AgentEventError::MissingDeadline)
    );
    assert_eq!(
        AgentEvent::reporting(run(), AgentPhase::AwaitingHuman, now(), None),
        Err(AgentEventError::MissingDeadline)
    );
}

#[test]
fn a_notice_cannot_carry_a_deadline_it_does_not_mean() {
    assert_eq!(
        AgentEvent::waiting(run(), AgentPhase::Completed, now(), now(), None),
        Err(AgentEventError::UnexpectedDeadline)
    );
}

#[test]
fn time_to_respond_floors_at_zero() {
    let deadline = now() + chrono::Duration::seconds(300);
    let event = AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, None).unwrap();
    assert_eq!(event.seconds_to_respond(now()), Some(300));
    assert_eq!(
        event.seconds_to_respond(now() + chrono::Duration::seconds(900)),
        Some(0)
    );
    let notice = AgentEvent::reporting(run(), AgentPhase::Completed, now(), None).unwrap();
    assert_eq!(notice.seconds_to_respond(now()), None);
}

#[test]
fn the_shared_filter_reads_this_family_without_being_taught_it() {
    // No filter of our own: `agent.*` works because the feed's filter
    // understands `<family>.*`, which is what keeps a third family from
    // needing a third copy of this logic (ADR 0080 §1).
    use opensesame_security_events::filter;

    let known: Vec<&str> = AGENT_EVENT_TYPES.to_vec();
    assert!(filter::matches(&[EVENT_WILDCARD.into()], EVENT_RUN_BLOCKED));
    assert!(filter::matches(&["*".into()], EVENT_RUN_BLOCKED));
    assert!(!filter::matches(&["lifecycle.*".into()], EVENT_RUN_BLOCKED));
    assert!(filter::is_valid(&[EVENT_WILDCARD.into()], &known));
    assert!(!filter::is_valid(&["agent.run.exploded".into()], &known));
    assert!(!filter::is_valid(&[], &known));
}

#[test]
fn every_phase_maps_onto_the_feed_and_the_loud_ones_are_the_stuck_ones() {
    use AgentPhase::{
        AwaitingHuman, Blocked, Completed, ControlGranted, ControlReleased, Failed, Resumed,
        Started,
    };
    assert_eq!(Started.severity(), Severity::Info);
    assert_eq!(ControlGranted.severity(), Severity::Info);
    assert_eq!(Resumed.severity(), Severity::Info);
    assert_eq!(Completed.severity(), Severity::Info);
    assert_eq!(AwaitingHuman.severity(), Severity::Warning);
    assert_eq!(ControlReleased.severity(), Severity::Warning);
    // The two that leave somebody's rotation not done.
    assert_eq!(Blocked.severity(), Severity::Error);
    assert_eq!(Failed.severity(), Severity::Error);
}

#[test]
fn a_blocked_run_opens_an_incident_that_a_person_arriving_closes() {
    // The property that makes this feed usable on call: every phase shares
    // one alert key per origin, so the resolve actually closes what the
    // fire opened rather than accumulating pages nobody can clear.
    let deadline = now() + chrono::Duration::seconds(300);
    let blocked = AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, None).unwrap();
    let granted = AgentEvent::reporting(run(), AgentPhase::ControlGranted, now(), None).unwrap();

    assert_eq!(blocked.notice().state, NoticeState::Firing);
    assert_eq!(granted.notice().state, NoticeState::Resolved);
    assert_eq!(blocked.notice().alert_key(), granted.notice().alert_key());

    // A run that failed did not rotate anything, so it is not settled.
    let failed = AgentEvent::reporting(run(), AgentPhase::Failed, now(), None).unwrap();
    assert_eq!(failed.notice().state, NoticeState::Firing);
}

#[test]
fn an_agent_alert_never_resolves_an_expiry_one_about_the_same_origin() {
    // Same subject, same organization, deliberately different incident:
    // the run finishing says nothing about when the password next expires.
    let completed = AgentEvent::reporting(run(), AgentPhase::Completed, now(), None)
        .unwrap()
        .notice();
    assert_eq!(completed.subject_kind, AGENT_SUBJECT_KIND);
    assert_eq!(completed.subject_id, "https://example.com");
    assert_eq!(completed.family(), "agent");
    assert!(completed.alert_key().starts_with("agent:"));
}

#[test]
fn the_notice_carries_the_reason_where_the_reason_is_the_actionable_part() {
    let deadline = now() + chrono::Duration::seconds(300);
    let blocked = AgentEvent::waiting(
        run(),
        AgentPhase::Blocked,
        now(),
        deadline,
        Some("step-up challenge on the settings page"),
    )
    .unwrap()
    .notice();
    assert_eq!(
        blocked.summary,
        "a password rotation at https://example.com is stuck and needs you: \
         step-up challenge on the settings page"
    );

    // A completed run's detail is bookkeeping, not something to read at
    // 04:00, so the one line stays the one line.
    let done = AgentEvent::reporting(run(), AgentPhase::Completed, now(), Some("2 steps"))
        .unwrap()
        .notice();
    assert_eq!(
        done.summary,
        "the password at https://example.com was rotated"
    );
}

#[test]
fn the_feeds_own_fence_finds_nothing_to_strip_from_an_agent_payload() {
    // `safe_payload` is ADR 0080's second fence behind each family's
    // structural test. It must be a no-op here — if it ever starts
    // removing a key, this family has grown one it should not have.
    let event = AgentEvent::reporting(run(), AgentPhase::Completed, now(), None).unwrap();
    let notice = event.notice();
    assert_eq!(notice.safe_payload(), event.payload());
}

#[test]
fn payload_is_value_blind_and_survives_the_audit_redactor() {
    let deadline = now() + chrono::Duration::seconds(300);
    let event = AgentEvent::waiting(
        run(),
        AgentPhase::Blocked,
        now(),
        deadline,
        Some("step-up challenge on the settings page"),
    )
    .unwrap();
    let payload = event.payload();
    let object = payload.as_object().unwrap();
    assert_eq!(object["event_type"], json!(EVENT_RUN_BLOCKED));
    assert_eq!(object["needs_human"], json!(true));
    assert_eq!(object["observation_included"], json!(false));
    assert_eq!(object["responds_by"], json!(deadline.to_rfc3339()));
    // ADR 0046 §14: `packages/audit`'s deny pass runs before its allowlist
    // and matches these as unanchored substrings, so any key containing one
    // is dropped even after being allowlisted — leaving a reviewer with a
    // blank where the fact was. No carve-out here: a key that needs an
    // exemption is a key that would arrive blank in an audit row.
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
            assert!(
                !key.contains(forbidden),
                "payload key `{key}` would be dropped by the audit redactor"
            );
        }
    }
}

#[test]
fn a_notice_omits_the_deadline_rather_than_nulling_it() {
    let event = AgentEvent::reporting(run(), AgentPhase::Completed, now(), None).unwrap();
    let payload = event.payload();
    let object = payload.as_object().unwrap();
    assert!(!object.contains_key("responds_by"));
    assert_eq!(object["needs_human"], json!(false));
}

#[test]
fn a_payload_round_trips_back_into_the_fact_it_described() {
    let deadline = now() + chrono::Duration::seconds(300);
    for original in [
        AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, Some("stuck")).unwrap(),
        AgentEvent::waiting(run(), AgentPhase::AwaitingHuman, now(), deadline, None).unwrap(),
        AgentEvent::reporting(run(), AgentPhase::Completed, now(), Some("done")).unwrap(),
        AgentEvent::reporting(run(), AgentPhase::Failed, now(), None).unwrap(),
        AgentEvent::reporting(run(), AgentPhase::Started, now(), None).unwrap(),
    ] {
        let rebuilt = AgentEvent::from_payload(&original.payload());
        assert_eq!(rebuilt.as_ref(), Some(&original), "{original:?}");
    }
}

#[test]
fn a_half_read_payload_is_refused_rather_than_repaired() {
    let deadline = now() + chrono::Duration::seconds(300);
    let event = AgentEvent::waiting(run(), AgentPhase::Blocked, now(), deadline, None).unwrap();

    // A missing field is not defaulted: a notification built from one would
    // name the wrong origin or the wrong person.
    for key in [
        "phase",
        "run_id",
        "origin",
        "owner_principal_id",
        "occurred_at",
    ] {
        let mut payload = event.payload();
        payload.as_object_mut().unwrap().remove(key);
        assert!(
            AgentEvent::from_payload(&payload).is_none(),
            "payload without {key} was accepted"
        );
    }

    // And the construction rule holds in both directions.
    let mut deadlineless = event.payload();
    deadlineless.as_object_mut().unwrap().remove("responds_by");
    assert!(AgentEvent::from_payload(&deadlineless).is_none());

    let mut notice = AgentEvent::reporting(run(), AgentPhase::Completed, now(), None)
        .unwrap()
        .payload();
    notice
        .as_object_mut()
        .unwrap()
        .insert("responds_by".into(), json!(deadline.to_rfc3339()));
    assert!(AgentEvent::from_payload(&notice).is_none());
}

#[test]
fn a_hint_is_truncated_rather_than_carried_whole() {
    let long = "x".repeat(MAX_DETAIL_CHARS + 200);
    let event = AgentEvent::reporting(run(), AgentPhase::Failed, now(), Some(&long)).unwrap();
    assert_eq!(
        event.detail.as_deref().unwrap().chars().count(),
        MAX_DETAIL_CHARS
    );
}
