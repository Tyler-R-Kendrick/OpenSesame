use opensesame_rotation_web::StepRequest;
use opensesame_storage::ObservationControlUpdate;
use serde_json::json;

use super::*;

const ORG: &str = "org:one";
const RUN: &str = "run:1";

fn req(step: &str) -> Value {
    json!({"step": step})
}

fn row(state: &str, quiescence: &str, queued: bool) -> StoredObservationRun {
    let human = state == "human_driving";
    StoredObservationRun {
        id: RUN.into(),
        organization_id: ORG.into(),
        job_id: "job:1".into(),
        target_origin: "https://example.com".into(),
        tier: "t3".into(),
        control_state: state.into(),
        quiescence: quiescence.into(),
        handoff_queued: queued,
        lease_holder: human.then(|| "principal:alice".into()),
        lease_expires_at: human.then(|| "2999-01-01T00:00:00+00:00".into()),
        owner_principal_id: "principal:alice".into(),
        viewer_key_id: "xkey:1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2999-01-01T00:00:00+00:00".into(),
        closed_at: None,
        version: 1,
        created_at: "2026-09-01T00:00:00+00:00".into(),
        updated_at: "2026-09-01T00:00:00+00:00".into(),
    }
}

async fn gate_over(state: &str, quiescence: &str, queued: bool) -> (ControlGate, Db) {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&row(state, quiescence, queued))
        .await
        .unwrap();
    (ControlGate::new(db.clone(), ORG.into(), RUN.into()), db)
}

async fn current(db: &Db) -> StoredObservationRun {
    db.get_observation_run(ORG, RUN).await.unwrap().unwrap()
}

/// What the control routes do for `POST …/handoff`: rebuild the lease from
/// the row, ask it, and write the result under the version it read.
async fn request_handoff_like_the_route(
    db: &Db,
) -> Option<opensesame_session_observe::HandoffOutcome> {
    for _ in 0..10 {
        let run = current(db).await;
        let mut lease = lease_of(&run).expect("a readable row");
        let outcome = lease.request_handoff().ok()?;
        let update = ObservationControlUpdate {
            run_id: run.id.clone(),
            organization_id: run.organization_id.clone(),
            expected_version: run.version,
            control_state: wire(lease.state()),
            quiescence: wire(lease.quiescence()),
            handoff_queued: lease.handoff_queued(),
            lease_holder: None,
            lease_expires_at: None,
            blocked_reason: run.blocked_reason.clone(),
        };
        if db
            .update_observation_control(&update, "2026-09-01T00:00:01+00:00")
            .await
            .unwrap()
            .is_some()
        {
            return Some(outcome);
        }
    }
    None
}

#[test]
fn the_steps_that_bound_the_critical_section_are_the_wire_names() {
    let assert = serde_json::to_value(StepRequest::AssertPresent {
        reference: "candidate:1".into(),
        selector: "#new".into(),
    })
    .unwrap();
    let submit = serde_json::to_value(StepRequest::Submit {
        selector: "#save".into(),
    })
    .unwrap();
    assert_eq!(assert["step"], ASSERT_STEP);
    assert_eq!(submit["step"], SUBMIT_STEP);
    assert_eq!(kind_of(&assert), Kind::Assert);
    assert_eq!(kind_of(&submit), Kind::Submit);
    for other in [
        "navigate",
        "fill_credential",
        "verify_login",
        "seal_candidate",
    ] {
        assert_eq!(kind_of(&req(other)), Kind::Ordinary, "{other}");
    }
}

#[test]
fn every_state_decides_every_kind_the_way_the_lease_machine_says() {
    use ControlState::{
        AgentDriving, AwaitingHuman, HandoffRequested, HumanDriving, ResumeRequested, Suspended,
    };
    let lease =
        |state, quiescence, queued| ControlLease::restore(state, quiescence, queued).unwrap();
    let proceeds = |kind, mut lease: ControlLease| {
        matches!(advance(kind, &mut lease), Decision::Proceed).then_some(lease)
    };

    // Between steps, the agent driving: an ordinary step goes, an assertion
    // opens the span, and a submit with no span open is refused.
    let quiet = lease(AgentDriving, Quiescence::Quiescent, false);
    assert_eq!(proceeds(Kind::Ordinary, quiet), Some(quiet));
    assert_eq!(
        proceeds(Kind::Assert, quiet).map(ControlLease::quiescence),
        Some(Quiescence::Critical)
    );
    let mut refused = quiet;
    assert!(matches!(
        advance(Kind::Submit, &mut refused),
        Decision::Refuse(Stop::Gone)
    ));

    // Inside the span nothing parks and nothing moves — not even with a
    // handoff waiting.
    for queued in [false, true] {
        let inside = lease(AgentDriving, Quiescence::Critical, queued);
        assert_eq!(proceeds(Kind::Submit, inside), Some(inside));
        assert_eq!(proceeds(Kind::Assert, inside), Some(inside));
    }

    // The span is over (the assertion failed): the queued handoff is released
    // and the very next step parks.
    let mut stale = lease(AgentDriving, Quiescence::Critical, true);
    assert!(matches!(
        advance(Kind::Ordinary, &mut stale),
        Decision::Park
    ));
    assert_eq!(stale.state(), AwaitingHuman);
    let mut stale = lease(AgentDriving, Quiescence::Critical, false);
    assert!(matches!(
        advance(Kind::Ordinary, &mut stale),
        Decision::Proceed
    ));
    assert_eq!(stale.quiescence(), Quiescence::Quiescent);

    // An accepted handoff parks at the next step of either kind, and a submit
    // is never sent on it.
    for kind in [Kind::Ordinary, Kind::Assert] {
        let mut asked = lease(HandoffRequested, Quiescence::Quiescent, false);
        assert!(matches!(advance(kind, &mut asked), Decision::Park));
        assert_eq!(asked.state(), AwaitingHuman);
    }
    let mut asked = lease(HandoffRequested, Quiescence::Quiescent, false);
    assert!(matches!(
        advance(Kind::Submit, &mut asked),
        Decision::Refuse(Stop::PersonHasIt)
    ));

    // A person's page, or nobody's: nothing is sent, and autonomy is never
    // resumed from here.
    for state in [AwaitingHuman, HumanDriving, ResumeRequested, Suspended] {
        for kind in [Kind::Ordinary, Kind::Assert, Kind::Submit] {
            let mut theirs = lease(state, Quiescence::Quiescent, false);
            assert!(
                matches!(
                    advance(kind, &mut theirs),
                    Decision::Refuse(Stop::PersonHasIt)
                ),
                "{state:?}"
            );
            assert_eq!(theirs.state(), state);
        }
    }
}

#[tokio::test]
async fn an_agent_driving_run_passes_and_writes_nothing() {
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    gate.before(&req("navigate")).await.unwrap();
    assert_eq!(
        current(&db).await.version,
        1,
        "an ordinary step leaves the row alone"
    );
    assert_eq!(gate.stopped(), None);
}

#[tokio::test]
async fn an_assertion_opens_the_span_on_the_row_and_a_submit_closes_it() {
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    gate.before(&req(ASSERT_STEP)).await.unwrap();
    let inside = current(&db).await;
    assert_eq!(inside.quiescence, "critical");
    assert_eq!(inside.control_state, "agent_driving");

    gate.before(&req(SUBMIT_STEP)).await.unwrap();
    assert_eq!(
        current(&db).await.version,
        inside.version,
        "the submit moves nothing"
    );
    gate.after(&req(SUBMIT_STEP), &Ok(json!({"outcome": "done"})))
        .await;
    let after = current(&db).await;
    assert_eq!(after.quiescence, "quiescent");
    assert_eq!(after.control_state, "agent_driving");
}

#[tokio::test]
async fn a_present_assertion_keeps_the_span_open_and_any_other_closes_it() {
    let present = json!({"outcome": "presence", "presence": "Present"});
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    gate.before(&req(ASSERT_STEP)).await.unwrap();
    gate.after(&req(ASSERT_STEP), &Ok(present)).await;
    assert_eq!(current(&db).await.quiescence, "critical");

    for outcome in [
        Ok(json!({"outcome": "presence", "presence": "Absent"})),
        Ok(json!({"outcome": "presence", "presence": "Mismatch"})),
        Ok(json!({"outcome": "done"})),
        Err(StepError::Transport),
    ] {
        let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
        gate.before(&req(ASSERT_STEP)).await.unwrap();
        gate.after(&req(ASSERT_STEP), &outcome).await;
        assert_eq!(current(&db).await.quiescence, "quiescent", "{outcome:?}");
    }
}

#[tokio::test]
async fn a_handoff_between_steps_parks_the_run_and_no_step_goes_out() {
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    assert_eq!(
        request_handoff_like_the_route(&db).await,
        Some(opensesame_session_observe::HandoffOutcome::Accepted)
    );
    assert_eq!(current(&db).await.control_state, "handoff_requested");

    assert_eq!(
        gate.before(&req("fill_credential")).await,
        Err(StepError::Transport)
    );
    let parked = current(&db).await;
    assert_eq!(parked.control_state, "awaiting_human");
    assert_eq!(parked.blocked_reason.as_deref(), Some(HANDOFF_PARKED));
    assert!(
        parked.closed_at.is_none(),
        "a person can still take the page"
    );
    assert_eq!(gate.stopped(), Some(Stop::HandedOff));
    // And nothing more, of any kind, after it.
    for step in ["navigate", ASSERT_STEP, SUBMIT_STEP] {
        assert!(gate.before(&req(step)).await.is_err(), "{step}");
    }
    assert_eq!(current(&db).await.control_state, "awaiting_human");
}

#[tokio::test]
async fn a_handoff_inside_the_span_is_queued_and_takes_effect_after_the_submit() {
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    gate.before(&req(ASSERT_STEP)).await.unwrap();
    gate.after(
        &req(ASSERT_STEP),
        &Ok(json!({"outcome": "presence", "presence": "Present"})),
    )
    .await;

    // The person asks mid-span: the routes queue it, they do not accept it.
    assert_eq!(
        request_handoff_like_the_route(&db).await,
        Some(opensesame_session_observe::HandoffOutcome::Queued)
    );
    let queued = current(&db).await;
    assert!((queued.control_state.as_str(), queued.handoff_queued) == ("agent_driving", true));

    // The submit — between the assertion and which nothing may interrupt — goes.
    gate.before(&req(SUBMIT_STEP)).await.unwrap();
    gate.after(&req(SUBMIT_STEP), &Ok(json!({"outcome": "done"})))
        .await;
    let released = current(&db).await;
    assert_eq!(released.control_state, "handoff_requested");
    assert_eq!(released.quiescence, "quiescent");
    assert!(!released.handoff_queued);

    // The step after the span parks.
    assert!(gate.before(&req("verify_login")).await.is_err());
    assert_eq!(current(&db).await.control_state, "awaiting_human");
    assert_eq!(gate.stopped(), Some(Stop::HandedOff));
}

#[tokio::test]
async fn a_page_a_person_holds_is_never_written_to_or_closed() {
    for state in [
        "awaiting_human",
        "human_driving",
        "resume_requested",
        "suspended",
    ] {
        let (gate, db) = gate_over(state, "quiescent", false).await;
        assert!(gate.before(&req("navigate")).await.is_err(), "{state}");
        assert_eq!(gate.stopped(), Some(Stop::PersonHasIt));
        let untouched = current(&db).await;
        assert_eq!(untouched.control_state, state);
        assert_eq!(untouched.version, 1);
        assert!(untouched.closed_at.is_none());
    }
}

#[tokio::test]
async fn a_closed_or_missing_run_takes_no_step() {
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    db.close_observation_run(ORG, RUN, "2026-09-01T00:00:02+00:00")
        .await
        .unwrap();
    assert!(gate.before(&req("navigate")).await.is_err());
    assert_eq!(gate.stopped(), Some(Stop::Gone));

    let orphan = ControlGate::new(db, ORG.into(), "run:nope".into());
    assert!(orphan.before(&req("navigate")).await.is_err());
    assert_eq!(orphan.stopped(), Some(Stop::Gone));
}

#[tokio::test]
async fn a_row_the_machine_could_not_have_written_is_refused() {
    let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
    // A queued handoff outside a critical section is a shape the machine
    // cannot produce; the row is corrupt, not merely stale.
    sqlx::query("UPDATE observation_runs SET handoff_queued = 1")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(gate.before(&req("navigate")).await.is_err());
    assert_eq!(gate.stopped(), Some(Stop::Gone));
}

#[tokio::test]
async fn a_handoff_racing_the_assertion_is_never_lost() {
    // Both writers read, decide and write under the row's version. However
    // they interleave, the person's request survives: either the run parks
    // before the span opens, or the span opens and the request is queued.
    for _ in 0..20 {
        let (gate, db) = gate_over("agent_driving", "quiescent", false).await;
        let assertion = req(ASSERT_STEP);
        let (asserted, requested) =
            tokio::join!(gate.before(&assertion), request_handoff_like_the_route(&db));
        let end = current(&db).await;
        let shape = (
            end.control_state.as_str(),
            end.quiescence.as_str(),
            end.handoff_queued,
        );
        assert!(requested.is_some(), "the request was written");
        match (asserted.is_ok(), shape) {
            (true, ("agent_driving", "critical", true)) => {}
            (false, ("awaiting_human", "quiescent", false)) => {
                assert_eq!(gate.stopped(), Some(Stop::HandedOff));
            }
            other => panic!("a lost or torn update: {other:?}"),
        }
    }
}
