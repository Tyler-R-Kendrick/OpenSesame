//! The run lease owns the run's credentials on the Host (ADR 0150 §6.2):
//! a misdirected surrogate parks a watched run and revokes what it holds; an
//! `agent.*` phase in which the agent stopped driving revokes; a person
//! taking the page revokes.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use opensesame_agent_events::{
    surrogate_refusal_notice, AgentEvent, AgentPhase, AgentRun, SurrogateRefusalReport,
};
use opensesame_security_events::SecurityNotice;
use opensesame_session_observe::RunCredentials;
use opensesame_storage::StoredObservationRun;

use super::{lease_from, state_name};
use crate::app_state::{test_demo_state, AppState};

const OWNER: &str = "principal:00000000-0000-4000-8000-000000000011";

/// Remembers which runs were revoked, and says one credential was live.
#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl Recorder {
    fn revoked(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

impl RunCredentials for Recorder {
    fn revoke(&self, run_id: &str) -> usize {
        self.0.lock().unwrap().push(run_id.to_owned());
        1
    }
}

fn at() -> DateTime<Utc> {
    "2026-09-28T00:00:00Z".parse().unwrap()
}

async fn host() -> (AppState, Arc<Recorder>, String) {
    let mut state = test_demo_state().await;
    let recorder = Arc::new(Recorder::default());
    state.run_credentials = recorder.clone();
    let organization = state.connection_organization.to_string();
    (state, recorder, organization)
}

fn run(id: &str, organization: &str, control: &str, quiescence: &str) -> StoredObservationRun {
    StoredObservationRun {
        id: id.into(),
        organization_id: organization.into(),
        job_id: "job:1".into(),
        target_origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: control.into(),
        quiescence: quiescence.into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: OWNER.into(),
        viewer_key_id: "xkey:viewer-1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2026-12-31T00:00:00+00:00".into(),
        closed_at: None,
        version: 1,
        created_at: "2026-09-28T00:00:00+00:00".into(),
        updated_at: "2026-09-28T00:00:00+00:00".into(),
    }
}

async fn seed(state: &AppState, run: &StoredObservationRun) {
    state.db.create_observation_run(run).await.unwrap();
}

async fn stored(state: &AppState, organization: &str, id: &str) -> StoredObservationRun {
    state
        .db
        .get_observation_run(organization, id)
        .await
        .unwrap()
        .unwrap()
}

fn refusal(code: &str, run_id: &str, organization: &str) -> SecurityNotice {
    surrogate_refusal_notice(&SurrogateRefusalReport {
        code,
        run_id: Some(run_id),
        provider_id: Some("github"),
        detail: Some("evil.test"),
        organization_id: Some(organization),
        occurred_at: at(),
    })
    .unwrap()
}

fn phase(phase: AgentPhase, run_id: &str, organization: &str) -> SecurityNotice {
    let run = AgentRun {
        run_id: run_id.into(),
        job_id: "job:1".into(),
        organization_id: organization.into(),
        owner_principal_id: OWNER.into(),
        origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: "agent_driving".into(),
    };
    let later = at() + chrono::Duration::seconds(600);
    if phase == AgentPhase::Blocked || phase == AgentPhase::AwaitingHuman {
        AgentEvent::waiting(run, phase, at(), later, None)
    } else {
        AgentEvent::reporting(run, phase, at(), None)
    }
    .unwrap()
    .notice()
}

#[tokio::test]
async fn a_misdirected_surrogate_parks_the_watched_run_and_revokes_what_it_holds() {
    let (state, recorder, org) = host().await;
    seed(&state, &run("run:1", &org, "agent_driving", "quiescent")).await;

    crate::security::dispatch::publish(
        &state,
        &refusal("surrogate.misdirected", "run:1", &org),
        at(),
    )
    .await;

    let parked = stored(&state, &org, "run:1").await;
    assert_eq!(parked.control_state, "awaiting_human", "{parked:?}");
    assert_eq!(
        parked.blocked_reason.as_deref(),
        Some("surrogate.misdirected")
    );
    assert_eq!(parked.lease_holder, None);
    assert_eq!(recorder.revoked(), ["run:1"]);
}

#[tokio::test]
async fn inside_the_critical_section_the_run_is_suspended_not_parked() {
    let (state, recorder, org) = host().await;
    seed(&state, &run("run:1", &org, "agent_driving", "critical")).await;

    crate::security::dispatch::publish(
        &state,
        &refusal("surrogate.misdirected", "run:1", &org),
        at(),
    )
    .await;

    let moved = stored(&state, &org, "run:1").await;
    assert_eq!(moved.control_state, "suspended", "{moved:?}");
    assert_eq!(
        moved.quiescence, "quiescent",
        "suspending clears the section"
    );
    assert_eq!(recorder.revoked(), ["run:1"]);
}

#[tokio::test]
async fn only_a_misdirected_surrogate_naming_a_run_the_agent_still_drives_parks_it() {
    let (state, recorder, org) = host().await;
    seed(&state, &run("run:1", &org, "agent_driving", "quiescent")).await;
    let mut human = run("run:human", &org, "human_driving", "quiescent");
    human.lease_holder = Some(OWNER.into());
    human.lease_expires_at = Some("2026-12-30T00:00:00+00:00".into());
    seed(&state, &human).await;
    seed(
        &state,
        &run("run:parked", &org, "awaiting_human", "quiescent"),
    )
    .await;

    let notices = [
        // Another fence: the feed's business, not a reason to park.
        refusal("surrogate.misplaced", "run:1", &org),
        refusal("surrogate.revoked", "run:1", &org),
        // Another run's tripwire.
        refusal("surrogate.misdirected", "run:other", &org),
        // A run nobody's agent drives has nothing to stop.
        refusal("surrogate.misdirected", "run:human", &org),
        refusal("surrogate.misdirected", "run:parked", &org),
        // Another organization's notice for a run id it does not own.
        refusal("surrogate.misdirected", "run:1", "org-elsewhere"),
    ];
    for notice in &notices {
        crate::security::dispatch::publish(&state, notice, at()).await;
    }

    assert_eq!(
        stored(&state, &org, "run:1").await.control_state,
        "agent_driving"
    );
    assert_eq!(
        stored(&state, &org, "run:human").await.control_state,
        "human_driving"
    );
    assert_eq!(
        stored(&state, &org, "run:parked").await.control_state,
        "awaiting_human"
    );
    assert!(recorder.revoked().is_empty(), "{:?}", recorder.revoked());
}

#[tokio::test]
async fn a_closed_run_is_left_alone() {
    let (state, recorder, org) = host().await;
    seed(&state, &run("run:1", &org, "agent_driving", "quiescent")).await;
    state
        .db
        .close_observation_run(&org, "run:1", "2026-09-28T00:00:01+00:00")
        .await
        .unwrap();

    crate::security::dispatch::publish(
        &state,
        &refusal("surrogate.misdirected", "run:1", &org),
        at(),
    )
    .await;

    let closed = stored(&state, &org, "run:1").await;
    assert_eq!(closed.control_state, "agent_driving");
    assert!(recorder.revoked().is_empty());
}

#[tokio::test]
async fn the_phases_in_which_the_agent_stopped_driving_revoke_and_the_others_do_not() {
    let (state, recorder, org) = host().await;
    for stopped in [
        AgentPhase::Blocked,
        AgentPhase::AwaitingHuman,
        AgentPhase::ControlGranted,
        AgentPhase::Completed,
        AgentPhase::Failed,
    ] {
        crate::security::dispatch::publish(&state, &phase(stopped, "run:1", &org), at()).await;
    }
    assert_eq!(recorder.revoked().len(), 5, "{:?}", recorder.revoked());
    assert!(recorder.revoked().iter().all(|id| id == "run:1"));

    let before = recorder.revoked().len();
    for driving in [
        AgentPhase::Started,
        AgentPhase::Resumed,
        AgentPhase::ControlReleased,
    ] {
        crate::security::dispatch::publish(&state, &phase(driving, "run:1", &org), at()).await;
    }
    assert_eq!(recorder.revoked().len(), before, "the agent is driving");
}

#[tokio::test]
async fn the_lease_projection_round_trips_through_its_names() {
    let (state, _recorder, org) = host().await;
    for control in [
        "agent_driving",
        "handoff_requested",
        "awaiting_human",
        "human_driving",
        "resume_requested",
        "suspended",
    ] {
        let lease = lease_from(&run("run:x", &org, control, "quiescent")).unwrap();
        assert_eq!(state_name(lease.state()), control);
    }
    assert!(lease_from(&run("run:x", &org, "unheard_of", "quiescent")).is_none());
    assert!(lease_from(&run("run:x", &org, "agent_driving", "unheard_of")).is_none());
    drop(state);
}
