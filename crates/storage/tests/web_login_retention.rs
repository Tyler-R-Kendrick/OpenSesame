//! What outlives a web-login run and what a crashed process strands
//! (ADR 0076 §5, ADR 0081, ADR 0156): retention removes a run's whole
//! footprint, the reaper's queries find only runs nobody is running, and the
//! step queue is closed to everything but the agent's own turn.

use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use opensesame_storage::{Db, StoredObservationRun};

const ORG: &str = "org:one";
const CREATED: &str = "2026-09-01T00:00:00+00:00";
const NOW: &str = "2026-09-01T01:00:00+00:00";
const EXPIRED: &str = "2026-08-01T00:00:00+00:00";
const FUTURE: &str = "2026-12-01T00:00:00+00:00";

fn run(id: &str, state: &str, expires_at: &str) -> StoredObservationRun {
    let human = state == "human_driving";
    StoredObservationRun {
        id: id.into(),
        organization_id: ORG.into(),
        job_id: format!("job:{id}"),
        target_origin: "https://example.com".into(),
        tier: "t3".into(),
        control_state: state.into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: human.then(|| "principal:alice".into()),
        lease_expires_at: human.then(|| "2026-09-01T02:00:00+00:00".into()),
        owner_principal_id: "principal:alice".into(),
        viewer_key_id: "xkey:1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: expires_at.into(),
        closed_at: None,
        version: 1,
        created_at: CREATED.into(),
        updated_at: CREATED.into(),
    }
}

fn record(run_id: &str) -> StoredAgentHookRecord {
    StoredAgentHookRecord {
        run_id: run_id.into(),
        organization_id: ORG.into(),
        sequence: 0,
        interception_point: "agent_startup".into(),
        decision: "allow".into(),
        escalated: false,
        reason: None,
        decided_by: None,
        input_identity: None,
        enforced_identity: None,
        policy_version: 0,
        recorded_at: CREATED.into(),
    }
}

async fn footprint(db: &Db, id: &str) -> Vec<u64> {
    let mut counts = Vec::new();
    for sql in [
        "SELECT COUNT(*) FROM observation_runs WHERE id = ?",
        "SELECT COUNT(*) FROM observation_events WHERE run_id = ?",
        "SELECT COUNT(*) FROM runner_steps WHERE run_id = ?",
        "SELECT COUNT(*) FROM agent_hook_records WHERE run_id = ?",
    ] {
        let count: i64 = sqlx::query_scalar(sql)
            .bind(id)
            .fetch_one(db.pool())
            .await
            .unwrap();
        counts.push(u64::try_from(count).unwrap());
    }
    counts
}

async fn populated(db: &Db, id: &str, expires_at: &str) {
    db.create_observation_run(&run(id, "agent_driving", expires_at))
        .await
        .unwrap();
    db.enqueue_runner_step(
        ORG,
        id,
        0,
        r#"{"step":"navigate","url":"https://example.com"}"#,
        CREATED,
    )
    .await
    .unwrap();
    db.append_observation_event(&opensesame_storage::ObservationAppend {
        organization_id: ORG,
        run_id: id,
        lane: "action",
        of_step: None,
        layout_epoch: None,
        payload: b"sealed",
        recorded_at: CREATED,
    })
    .await
    .unwrap();
    db.append_agent_hook_records(&[record(id)]).await.unwrap();
    assert_eq!(footprint(db, id).await, [1, 1, 1, 1]);
}

#[tokio::test]
async fn retention_removes_a_runs_whole_footprint_and_only_the_expired_ones() {
    let db = Db::connect_memory().await.unwrap();
    populated(&db, "run:old", EXPIRED).await;
    populated(&db, "run:new", FUTURE).await;

    let purged = db.purge_expired_web_login_runs(NOW).await.unwrap();
    assert_eq!(
        (
            purged.runs,
            purged.events,
            purged.steps,
            purged.hook_records
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(footprint(&db, "run:old").await, [0, 0, 0, 0]);
    assert_eq!(footprint(&db, "run:new").await, [1, 1, 1, 1]);
    assert_eq!(
        db.purge_expired_web_login_runs(NOW).await.unwrap(),
        opensesame_storage::web_login_runs::retention::WebLoginPurge::default()
    );
}

#[tokio::test]
async fn the_older_purge_entry_point_covers_the_same_footprint() {
    let db = Db::connect_memory().await.unwrap();
    populated(&db, "run:old", EXPIRED).await;
    assert_eq!(db.purge_expired_observation_runs(NOW).await.unwrap(), 1);
    assert_eq!(footprint(&db, "run:old").await, [0, 0, 0, 0]);
}

#[tokio::test]
async fn only_an_open_run_nobody_holds_is_stranded() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:driving", "agent_driving", FUTURE))
        .await
        .unwrap();
    db.create_observation_run(&run("run:held", "human_driving", FUTURE))
        .await
        .unwrap();
    db.create_observation_run(&run("run:closed", "agent_driving", FUTURE))
        .await
        .unwrap();
    db.close_observation_run(ORG, "run:closed", CREATED)
        .await
        .unwrap();

    // Younger than the cutoff: nothing is stranded yet.
    assert!(db
        .stranded_observation_runs(CREATED, NOW)
        .await
        .unwrap()
        .is_empty());
    let stranded = db.stranded_observation_runs(NOW, NOW).await.unwrap();
    let ids: Vec<_> = stranded.iter().map(|run| run.run_id.as_str()).collect();
    assert_eq!(
        ids,
        ["run:driving"],
        "a person's live lease has its own clock"
    );
    assert_eq!(stranded[0].job_id, "job:run:driving");

    // Once the person's lease has lapsed the run is stranded too.
    let later = "2026-09-01T03:00:00+00:00";
    let ids: Vec<_> = db
        .stranded_observation_runs(later, later)
        .await
        .unwrap()
        .into_iter()
        .map(|run| run.run_id)
        .collect();
    assert_eq!(ids, ["run:driving", "run:held"]);
}

#[tokio::test]
async fn closing_a_stranded_run_parks_it_for_a_person_and_closes_its_queue() {
    let db = Db::connect_memory().await.unwrap();
    populated(&db, "run:1", FUTURE).await;
    let reason = "x".repeat(400);
    assert!(db
        .close_stranded_observation_run(ORG, "run:1", &reason, NOW)
        .await
        .unwrap());
    let closed = db.get_observation_run(ORG, "run:1").await.unwrap().unwrap();
    assert_eq!(closed.control_state, "suspended");
    assert!(closed.closed_at.is_some());
    assert_eq!(closed.lease_holder, None);
    assert!(closed.blocked_reason.unwrap().chars().count() <= 160);
    assert_eq!(closed.version, 2);
    // Closed once, by one caller.
    assert!(!db
        .close_stranded_observation_run(ORG, "run:1", "again", NOW)
        .await
        .unwrap());
    // Its step can no longer be claimed or added to.
    assert!(db
        .claim_runner_step(ORG, "run:1", "alice", NOW, FUTURE)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .enqueue_runner_step(ORG, "run:1", 1, "{}", NOW)
        .await
        .is_err());

    // A run a person holds under a live lease is not closed from under them.
    db.create_observation_run(&run("run:held", "human_driving", FUTURE))
        .await
        .unwrap();
    assert!(!db
        .close_stranded_observation_run(ORG, "run:held", "gone", NOW)
        .await
        .unwrap());
}

#[tokio::test]
async fn no_step_is_queued_or_claimed_while_a_person_holds_the_page() {
    for state in [
        "awaiting_human",
        "human_driving",
        "resume_requested",
        "suspended",
    ] {
        let db = Db::connect_memory().await.unwrap();
        db.create_observation_run(&run("run:1", state, FUTURE))
            .await
            .unwrap();
        assert!(
            db.enqueue_runner_step(ORG, "run:1", 0, "{}", NOW)
                .await
                .is_err(),
            "{state} takes no step"
        );
    }
    // An accepted handoff is still the agent's turn until its next safe point;
    // a step already queued may be claimed, and once the run is parked it may
    // not.
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1", "agent_driving", FUTURE))
        .await
        .unwrap();
    db.enqueue_runner_step(ORG, "run:1", 0, "{}", NOW)
        .await
        .unwrap();
    sqlx::query("UPDATE observation_runs SET control_state = 'handoff_requested'")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db
        .claim_runner_step(ORG, "run:1", "alice", NOW, FUTURE)
        .await
        .unwrap()
        .is_some());
    sqlx::query("UPDATE observation_runs SET control_state = 'awaiting_human'")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE runner_steps SET state = 'pending', claimed_by = NULL, claim_expires_at = NULL",
    )
    .execute(db.pool())
    .await
    .unwrap();
    assert!(db
        .claim_runner_step(ORG, "run:1", "alice", NOW, FUTURE)
        .await
        .unwrap()
        .is_none());
}
