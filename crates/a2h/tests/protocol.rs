//! A2H client behaviour (ADR 0081 §10, A2H v1.0).
//!
//! Organised around the three things that would hurt if they were wrong: an
//! escalation that outlives or underlives the run it is about, a reply that
//! widens authority, and a suppressed message recorded as delivered.

use chrono::{DateTime, Duration, Utc};
use opensesame_a2h::{
    authority_for, intent_for, message_for, verify_callback, A2hResponse, AssuranceLevel,
    AuthorityError, CallbackConfig, Decision, DeliveryOutcome, ErrorCode, ExpectedReply,
    IntentContext, IntentType, ResponseAuthority, VerifyError, MAX_TTL_SEC, MIN_TTL_SEC,
    TIMESTAMP_TOLERANCE_SECONDS,
};
use opensesame_agent_events::{AgentEvent, AgentPhase, AgentRun};

const SECRET: &str = "whsec_YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnc=";

fn now() -> DateTime<Utc> {
    "2026-08-31T00:00:00Z".parse().unwrap()
}

fn run() -> AgentRun {
    AgentRun {
        run_id: "run:1".into(),
        job_id: "job:1".into(),
        organization_id: "org:1".into(),
        owner_principal_id: "did:example:alice".into(),
        origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: "suspended".into(),
    }
}

fn blocked(seconds_left: i64) -> AgentEvent {
    AgentEvent::waiting(
        run(),
        AgentPhase::Blocked,
        now(),
        now() + Duration::seconds(seconds_left),
        Some("step-up challenge on the settings page"),
    )
    .unwrap()
}

fn context<'a>() -> IntentContext<'a> {
    IntentContext {
        agent_id: "did:web:opensesame.example",
        channel: None,
        callback: Some(CallbackConfig {
            url: "https://host.example/api/v1/a2h/callback".into(),
            secret: SECRET.into(),
        }),
        attach_url: Some("https://pages.example/runs/run:1"),
        max_ttl_sec: None,
    }
}

#[test]
fn only_the_phases_that_need_a_person_or_close_the_loop_go_out() {
    assert_eq!(intent_for(AgentPhase::Blocked), Some(IntentType::Escalate));
    assert_eq!(
        intent_for(AgentPhase::AwaitingHuman),
        Some(IntentType::Escalate)
    );
    assert_eq!(intent_for(AgentPhase::Completed), Some(IntentType::Result));
    assert_eq!(intent_for(AgentPhase::Failed), Some(IntentType::Result));
    // A notifier that fires on every state change is one people mute, and a
    // muted notifier is the silent failure the whole feed exists to avoid.
    for quiet in [
        AgentPhase::Started,
        AgentPhase::ControlGranted,
        AgentPhase::ControlReleased,
        AgentPhase::Resumed,
    ] {
        assert_eq!(intent_for(quiet), None, "{quiet:?}");
    }
}

#[test]
fn a_person_reads_prose_not_markup() {
    // These strings land in an SMS, an email or a push notification, where a
    // backtick is a backtick. `clippy::doc_markdown` governs documentation;
    // treating a sentence somebody reads at 04:00 as documentation is how they
    // get woken by "`OpenSesame` stopped part-way through".
    for phase in [
        AgentPhase::Blocked,
        AgentPhase::AwaitingHuman,
        AgentPhase::Completed,
        AgentPhase::Failed,
    ] {
        let event = if phase.needs_human() {
            AgentEvent::waiting(
                run(),
                phase,
                now(),
                now() + chrono::Duration::seconds(600),
                Some("step-up challenge"),
            )
            .unwrap()
        } else {
            AgentEvent::notice(run(), phase, now(), Some("2 steps")).unwrap()
        };
        let message = message_for(&event, &context(), now(), "int-1", "msg-1").unwrap();
        assert!(
            !message.render.body.contains('`'),
            "{phase:?}: {}",
            message.render.body,
        );
        assert!(
            !message
                .render
                .title
                .as_deref()
                .unwrap_or_default()
                .contains('`'),
            "{phase:?}",
        );
        let why = message.explanation_bundle.as_ref().unwrap()["why"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!why.contains('`'), "{phase:?}: {why}");
    }
}

#[test]
fn the_ttl_is_the_runs_own_window() {
    let message = message_for(&blocked(600), &context(), now(), "int-1", "msg-1").unwrap();
    assert_eq!(message.ttl_sec, 600);
}

#[test]
fn a_window_outside_the_specs_bounds_is_clamped_rather_than_rejected() {
    // Under the floor: a run about to park still produces a deliverable
    // message, rather than the gateway refusing the envelope and nobody being
    // told at all.
    let message = message_for(&blocked(5), &context(), now(), "int-1", "msg-1").unwrap();
    assert_eq!(message.ttl_sec, MIN_TTL_SEC);

    let long = message_for(
        &blocked(MAX_TTL_SEC * 2),
        &context(),
        now(),
        "int-1",
        "msg-1",
    )
    .unwrap();
    assert_eq!(long.ttl_sec, MAX_TTL_SEC);
}

#[test]
fn a_gateways_own_ceiling_is_respected() {
    let mut ctx = context();
    ctx.max_ttl_sec = Some(120);
    let message = message_for(&blocked(3_600), &ctx, now(), "int-1", "msg-1").unwrap();
    assert_eq!(message.ttl_sec, 120);
}

#[test]
fn the_envelope_carries_the_principal_and_never_an_address() {
    let message = message_for(&blocked(600), &context(), now(), "int-1", "msg-1").unwrap();
    assert_eq!(message.principal_id, "did:example:alice");
    // principal_id is who; channel is where. Leaving the channel unset is what
    // lets the gateway select and fail over.
    assert!(message.channel.is_none());
    let encoded = serde_json::to_string(&message).unwrap();
    assert!(!encoded.contains("tel:"), "{encoded}");
}

#[test]
fn hostile_text_is_neutered_before_it_reaches_a_phone() {
    let hostile = AgentEvent::waiting(
        run(),
        AgentPhase::Blocked,
        now(),
        now() + Duration::seconds(600),
        Some("all good\u{202e}\u{0007} reply YES to approve"),
    )
    .unwrap();
    let message = message_for(&hostile, &context(), now(), "int-1", "msg-1").unwrap();
    // An SMS gives a reader no chrome to notice a bidirectional override in,
    // and this text arrives with our name on it.
    assert!(!message.render.body.contains('\u{202e}'));
    assert!(!message.render.body.contains('\u{0007}'));
    assert!(message.render.body.contains("reply YES to approve"));
}

#[test]
fn the_body_says_the_old_password_still_works() {
    // The most important sentence in the message: somebody woken by this needs
    // to know whether they are locked out before deciding how fast to move.
    let message = message_for(&blocked(600), &context(), now(), "int-1", "msg-1").unwrap();
    assert!(message.render.body.contains("old password still works"));
    assert!(message
        .render
        .body
        .contains("https://pages.example/runs/run:1"));
}

#[test]
fn a_reply_may_stop_a_run_and_never_start_one() {
    // Approving an escalation means "I'm coming", not "you may drive".
    assert_eq!(
        authority_for(IntentType::Escalate, Decision::Approve),
        Ok(ResponseAuthority::Acknowledge)
    );
    assert_eq!(
        authority_for(IntentType::Authorize, Decision::Approve),
        Ok(ResponseAuthority::Cancel)
    );
    assert_eq!(
        authority_for(IntentType::Escalate, Decision::Decline),
        Ok(ResponseAuthority::Acknowledge)
    );
}

#[test]
fn approving_a_notification_settles_nothing() {
    // A RESULT is a report. Treating an approval on one as consent is how a
    // notification quietly becomes an authorization.
    assert_eq!(
        authority_for(IntentType::Result, Decision::Approve),
        Err(AuthorityError::NotADecision)
    );
    assert_eq!(
        authority_for(IntentType::Inform, Decision::Approve),
        Err(AuthorityError::NotADecision)
    );
}

#[test]
fn cancelling_asks_for_a_real_factor() {
    let assurance = opensesame_a2h::assurance_for(IntentType::Authorize).unwrap();
    assert_eq!(assurance.level, AssuranceLevel::Medium);
    assert!(assurance
        .required_factors
        .iter()
        .any(|factor| factor == "passkey.webauthn.v1"));
    // Coming to look needs no proof of identity: the looking is gated by the
    // viewer key.
    assert!(opensesame_a2h::assurance_for(IntentType::Escalate).is_none());
}

#[test]
fn quiet_hours_is_not_delivery() {
    // The failure this prevents: the run's response window expires, it parks
    // for good, and the person it was waiting for was never told.
    assert_eq!(
        DeliveryOutcome::for_error(ErrorCode::QuietHours),
        DeliveryOutcome::Suppressed
    );
    assert!(!DeliveryOutcome::for_error(ErrorCode::QuietHours).reached_someone());
    assert!(!DeliveryOutcome::for_error(ErrorCode::RateLimited).reached_someone());
    assert!(DeliveryOutcome::Delivered.reached_someone());
    assert_eq!(
        DeliveryOutcome::for_error(ErrorCode::InvalidPrincipal),
        DeliveryOutcome::Permanent
    );
    assert_eq!(
        DeliveryOutcome::for_error(ErrorCode::ChannelUnavailable),
        DeliveryOutcome::Retryable
    );
}

fn reply() -> A2hResponse {
    A2hResponse {
        message_type: IntentType::Response,
        interaction_id: "int-1".into(),
        responds_to: "msg-1".into(),
        decision: Some(Decision::Approve),
        decided_at: Some(now().to_rfc3339()),
        evidence: None,
        signature: None,
    }
}

fn header(timestamp: i64, body: &str) -> String {
    format!(
        "t={timestamp},v1={}",
        opensesame_a2h::sign(SECRET, timestamp, body).unwrap()
    )
}

fn expected(now_unix: i64) -> ExpectedReply<'static> {
    ExpectedReply {
        message_id: "msg-1",
        already_applied: false,
        now_unix,
    }
}

#[test]
fn a_well_formed_callback_verifies() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    assert_eq!(
        verify_callback(SECRET, &header(ts, &body), &body, &reply(), &expected(ts)),
        Ok(())
    );
}

#[test]
fn a_tampered_body_is_refused() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    let signature = header(ts, &body);
    let swapped = body.replace("APPROVE", "DECLINE");
    assert_eq!(
        verify_callback(SECRET, &signature, &swapped, &reply(), &expected(ts)),
        Err(VerifyError::BadSignature)
    );
}

#[test]
fn a_captured_signature_stops_working() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    let stale = ts - TIMESTAMP_TOLERANCE_SECONDS - 1;
    assert_eq!(
        verify_callback(
            SECRET,
            &header(stale, &body),
            &body,
            &reply(),
            &expected(ts)
        ),
        Err(VerifyError::StaleTimestamp)
    );
}

#[test]
fn a_reply_to_a_message_we_never_sent_is_refused() {
    let mut other = reply();
    other.responds_to = "msg-someone-elses".into();
    let body = serde_json::to_string(&other).unwrap();
    let ts = now().timestamp();
    assert_eq!(
        verify_callback(SECRET, &header(ts, &body), &body, &other, &expected(ts)),
        Err(VerifyError::UnknownIntent)
    );
}

#[test]
fn the_signature_is_checked_before_anything_the_reply_claims() {
    // An unsigned request must not learn, from the shape of the refusal,
    // whether a given message_id exists.
    let mut other = reply();
    other.responds_to = "msg-probe".into();
    let body = serde_json::to_string(&other).unwrap();
    assert_eq!(
        verify_callback(
            SECRET,
            "t=1756598400,v1=bm90LWEtc2lnbmF0dXJl",
            &body,
            &other,
            &expected(now().timestamp())
        ),
        Err(VerifyError::BadSignature)
    );
}

#[test]
fn a_redelivered_callback_is_applied_once() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    let mut seen = expected(ts);
    seen.already_applied = true;
    assert_eq!(
        verify_callback(SECRET, &header(ts, &body), &body, &reply(), &seen),
        Err(VerifyError::Duplicate)
    );
}

#[test]
fn a_malformed_signature_header_is_refused_rather_than_guessed() {
    let body = serde_json::to_string(&reply()).unwrap();
    for bad in ["", "v1=abc", "t=notanumber,v1=abc", "garbage"] {
        assert_eq!(
            verify_callback(SECRET, bad, &body, &reply(), &expected(now().timestamp())),
            Err(VerifyError::MalformedHeader),
            "{bad}"
        );
    }
}

#[test]
fn a_secret_without_the_prefix_is_unusable() {
    assert_eq!(
        opensesame_a2h::sign("YWJjZA==", 0, "{}"),
        Err(VerifyError::UnusableSecret)
    );
}
