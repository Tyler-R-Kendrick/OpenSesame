//! The sealed observation log's invariants (ADR 0078).
//!
//! Three properties are the point of this suite, and each one is a bug class
//! the schema is meant to make unrepresentable rather than merely unlikely:
//! a gapless log under concurrent appenders, one driver at a time across
//! processes, and a shape that cannot hold a body the gateway could read.

use opensesame_storage::{Db, ObservationAppend, ObservationControlUpdate, StoredObservationRun};

const ORG: &str = "org:one";
const NOW: &str = "2026-08-31T00:00:00+00:00";
const LATER: &str = "2026-09-30T00:00:00+00:00";

fn run(id: &str) -> StoredObservationRun {
    StoredObservationRun {
        id: id.into(),
        organization_id: ORG.into(),
        job_id: "job:1".into(),
        target_origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: "agent_driving".into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: "principal:alice".into(),
        viewer_key_id: "xkey:viewer-1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: LATER.into(),
        closed_at: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn append<'a>(run_id: &'a str, lane: &'a str, payload: &'a [u8]) -> ObservationAppend<'a> {
    ObservationAppend {
        organization_id: ORG,
        run_id,
        lane,
        of_step: None,
        layout_epoch: None,
        payload,
        recorded_at: NOW,
    }
}

fn control(run_id: &str, expected_version: i64, state: &str) -> ObservationControlUpdate {
    ObservationControlUpdate {
        run_id: run_id.into(),
        organization_id: ORG.into(),
        expected_version,
        control_state: state.into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        blocked_reason: None,
    }
}

#[tokio::test]
async fn the_log_is_gapless_and_ordered() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();

    for expected in 0..5i64 {
        let seq = db
            .append_observation_event(&append("run:1", "action", b"sealed"))
            .await
            .unwrap();
        assert_eq!(seq, expected);
    }

    let events = db
        .read_observation_events(ORG, "run:1", -1, 100)
        .await
        .unwrap();
    assert_eq!(
        events.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4]
    );
}

#[tokio::test]
async fn live_tail_and_replay_seek_are_the_same_read() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();
    for _ in 0..4 {
        db.append_observation_event(&append("run:1", "action", b"sealed"))
            .await
            .unwrap();
    }

    // A viewer tailing from its last position.
    let tail = db
        .read_observation_events(ORG, "run:1", 2, 100)
        .await
        .unwrap();
    assert_eq!(tail.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3]);

    // The replay overlay seeking to the same place, through the same call.
    let seek = db
        .read_observation_events(ORG, "run:1", -1, 100)
        .await
        .unwrap();
    assert_eq!(seek.len(), 4);
}

#[tokio::test]
async fn a_thought_names_its_step_and_a_frame_names_its_epoch() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();

    db.append_observation_event(&ObservationAppend {
        of_step: Some(0),
        ..append("run:1", "thought", b"sealed")
    })
    .await
    .unwrap();
    db.append_observation_event(&ObservationAppend {
        layout_epoch: Some(7),
        ..append("run:1", "frame", b"sealed")
    })
    .await
    .unwrap();

    // A thought with no step, and a frame with no epoch, are refused by the
    // schema rather than stored as a shape the reader cannot interpret.
    assert!(db
        .append_observation_event(&append("run:1", "thought", b"sealed"))
        .await
        .is_err());
    assert!(db
        .append_observation_event(&append("run:1", "frame", b"sealed"))
        .await
        .is_err());
    // And neither may carry the other's field.
    assert!(db
        .append_observation_event(&ObservationAppend {
            of_step: Some(1),
            ..append("run:1", "action", b"sealed")
        })
        .await
        .is_err());
}

#[tokio::test]
async fn an_empty_payload_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();
    assert!(db
        .append_observation_event(&append("run:1", "action", b""))
        .await
        .is_err());
}

#[tokio::test]
async fn only_one_process_wins_a_control_transition() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();

    // Two gateway processes both read version 1 and both decide to park.
    let first = db
        .update_observation_control(&control("run:1", 1, "awaiting_human"), NOW)
        .await
        .unwrap();
    assert!(first.is_some());
    assert_eq!(first.unwrap().version, 2);

    let second = db
        .update_observation_control(&control("run:1", 1, "awaiting_human"), NOW)
        .await
        .unwrap();
    assert!(
        second.is_none(),
        "the stale writer must re-read rather than overwrite a grant it did not see"
    );
}

#[tokio::test]
async fn a_driver_and_a_driving_state_cannot_exist_without_each_other() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();

    // Naming a holder while the state says the agent drives.
    let mut bogus = control("run:1", 1, "agent_driving");
    bogus.lease_holder = Some("viewer:alice".into());
    bogus.lease_expires_at = Some(LATER.into());
    assert!(db.update_observation_control(&bogus, NOW).await.is_err());

    // Claiming human control with nobody named.
    let anonymous = control("run:1", 1, "human_driving");
    assert!(db
        .update_observation_control(&anonymous, NOW)
        .await
        .is_err());

    // The well-formed grant.
    let mut granted = control("run:1", 1, "human_driving");
    granted.lease_holder = Some("viewer:alice".into());
    granted.lease_expires_at = Some(LATER.into());
    let stored = db
        .update_observation_control(&granted, NOW)
        .await
        .unwrap()
        .expect("grant applies");
    assert_eq!(stored.lease_holder.as_deref(), Some("viewer:alice"));
}

#[tokio::test]
async fn a_lease_without_an_expiry_is_refused() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();
    let mut forever = control("run:1", 1, "human_driving");
    forever.lease_holder = Some("viewer:alice".into());
    assert!(db.update_observation_control(&forever, NOW).await.is_err());
}

#[tokio::test]
async fn a_closed_run_stops_growing() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();
    db.append_observation_event(&append("run:1", "action", b"sealed"))
        .await
        .unwrap();
    db.close_observation_run(ORG, "run:1", NOW).await.unwrap();

    assert!(db
        .append_observation_event(&append("run:1", "action", b"sealed"))
        .await
        .is_err());
    assert!(db
        .update_observation_control(&control("run:1", 2, "suspended"), NOW)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn retention_takes_the_log_with_the_run() {
    let db = Db::connect_memory().await.unwrap();
    let mut expired = run("run:old");
    expired.expires_at = "2026-08-01T00:00:00+00:00".into();
    db.create_observation_run(&expired).await.unwrap();
    db.create_observation_run(&run("run:live")).await.unwrap();
    for id in ["run:old", "run:live"] {
        db.append_observation_event(&append(id, "action", b"sealed"))
            .await
            .unwrap();
    }

    let removed = db.purge_expired_observation_runs(NOW).await.unwrap();
    assert_eq!(removed, 1);
    assert!(db
        .get_observation_run(ORG, "run:old")
        .await
        .unwrap()
        .is_none());
    assert!(db
        .read_observation_events(ORG, "run:old", -1, 100)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        db.read_observation_events(ORG, "run:live", -1, 100)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_run_is_scoped_to_its_tenant() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();
    db.append_observation_event(&append("run:1", "action", b"sealed"))
        .await
        .unwrap();

    assert!(db
        .get_observation_run("org:two", "run:1")
        .await
        .unwrap()
        .is_none());
    assert!(db
        .read_observation_events("org:two", "run:1", -1, 100)
        .await
        .unwrap()
        .is_empty());
    assert!(db
        .append_observation_event(&ObservationAppend {
            organization_id: "org:two",
            ..append("run:1", "action", b"sealed")
        })
        .await
        .is_err());
}

#[tokio::test]
async fn a_sealed_event_never_renders_its_body() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1")).await.unwrap();
    db.append_observation_event(&append("run:1", "action", b"super-secret"))
        .await
        .unwrap();
    let events = db
        .read_observation_events(ORG, "run:1", -1, 10)
        .await
        .unwrap();
    let rendered = format!("{:?}", events[0]);
    assert!(!rendered.contains("super-secret"), "{rendered}");
    assert!(rendered.contains("payload_len"));
}
