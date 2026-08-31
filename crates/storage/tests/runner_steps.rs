//! The step queue's invariants (ADR 0079 §4).
//!
//! Every test here is a way a second actor could take a step that is not
//! theirs, or an executor could be left waiting forever.

use opensesame_storage::{Db, StoredObservationRun};

const ORG: &str = "org:one";
const NOW: &str = "2026-08-31T00:00:00+00:00";
const LATER: &str = "2026-08-31T00:02:00+00:00";
const MUCH_LATER: &str = "2026-08-31T09:00:00+00:00";

fn run() -> StoredObservationRun {
    StoredObservationRun {
        id: "run:1".into(),
        organization_id: ORG.into(),
        job_id: "job:1".into(),
        target_origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: "agent_driving".into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: "user:alice".into(),
        viewer_key_id: "xkey:1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2026-12-31T00:00:00+00:00".into(),
        closed_at: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

async fn seeded() -> Db {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run()).await.unwrap();
    db
}

const REQUEST: &str = r#"{"step":"navigate","url":"https://example.com"}"#;
const OUTCOME: &str = r#"{"outcome":"done"}"#;

#[tokio::test]
async fn a_claimed_step_comes_back_to_its_claimant() {
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();

    let claimed = db
        .claim_runner_step(ORG, "run:1", "device:alice", NOW, LATER)
        .await
        .unwrap()
        .expect("a pending step is claimable");
    assert_eq!(claimed.state, "claimed");
    assert_eq!(claimed.claimed_by.as_deref(), Some("device:alice"));
    assert_eq!(claimed.request_json, REQUEST);

    assert!(db
        .settle_runner_step(ORG, "run:1", 0, "device:alice", OUTCOME, NOW)
        .await
        .unwrap());
    let settled = db.get_runner_step(ORG, "run:1", 0).await.unwrap().unwrap();
    assert_eq!(settled.state, "settled");
    assert_eq!(settled.outcome_json.as_deref(), Some(OUTCOME));
}

#[tokio::test]
async fn one_step_at_a_time_per_run() {
    // A browser has one DOM. A queue that could hold two steps for one page
    // would be a queue that could reorder them.
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    assert!(db
        .enqueue_runner_step(ORG, "run:1", 1, REQUEST, NOW)
        .await
        .is_err());

    // Once the first settles, the next may be queued.
    db.claim_runner_step(ORG, "run:1", "device:alice", NOW, LATER)
        .await
        .unwrap();
    db.settle_runner_step(ORG, "run:1", 0, "device:alice", OUTCOME, NOW)
        .await
        .unwrap();
    assert!(db
        .enqueue_runner_step(ORG, "run:1", 1, REQUEST, NOW)
        .await
        .is_ok());
}

#[tokio::test]
async fn only_the_claimant_settles() {
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    db.claim_runner_step(ORG, "run:1", "device:alice", NOW, LATER)
        .await
        .unwrap();

    assert!(
        !db.settle_runner_step(ORG, "run:1", 0, "device:mallory", OUTCOME, NOW)
            .await
            .unwrap(),
        "a step is settled by whoever holds it, not by whoever asks"
    );
    let still_open = db.get_runner_step(ORG, "run:1", 0).await.unwrap().unwrap();
    assert_eq!(still_open.state, "claimed");
}

#[tokio::test]
async fn a_live_claim_is_not_stealable() {
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    db.claim_runner_step(ORG, "run:1", "device:alice", NOW, LATER)
        .await
        .unwrap();

    assert!(db
        .claim_runner_step(ORG, "run:1", "device:other", NOW, LATER)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_lapsed_claim_is_reclaimable() {
    // A driver that crashed releases its work by the clock rather than by
    // anybody deciding it is dead.
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    db.claim_runner_step(ORG, "run:1", "device:gone", NOW, LATER)
        .await
        .unwrap();

    let retaken = db
        .claim_runner_step(ORG, "run:1", "device:fresh", MUCH_LATER, MUCH_LATER)
        .await
        .unwrap()
        .expect("a lapsed claim is claimable");
    assert_eq!(retaken.claimed_by.as_deref(), Some("device:fresh"));

    // And the driver that lost it cannot settle it afterwards.
    assert!(!db
        .settle_runner_step(ORG, "run:1", 0, "device:gone", OUTCOME, MUCH_LATER)
        .await
        .unwrap());
}

#[tokio::test]
async fn an_unclaimed_step_cannot_be_settled() {
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    assert!(!db
        .settle_runner_step(ORG, "run:1", 0, "device:alice", OUTCOME, NOW)
        .await
        .unwrap());
}

#[tokio::test]
async fn a_settled_step_always_carries_an_outcome() {
    // A settled step with no outcome is one the executor waits on forever, so
    // the schema refuses the shape rather than trusting a caller.
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    db.claim_runner_step(ORG, "run:1", "device:alice", NOW, LATER)
        .await
        .unwrap();
    assert!(db
        .settle_runner_step(ORG, "run:1", 0, "device:alice", "", NOW)
        .await
        .is_err());
}

#[tokio::test]
async fn steps_are_scoped_to_their_tenant() {
    let db = seeded().await;
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();
    assert!(db
        .claim_runner_step("org:two", "run:1", "device:alice", NOW, LATER)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .get_runner_step("org:two", "run:1", 0)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_purged_run_takes_its_steps_with_it() {
    let db = Db::connect_memory().await.unwrap();
    let mut expired = run();
    expired.expires_at = "2026-08-01T00:00:00+00:00".into();
    db.create_observation_run(&expired).await.unwrap();
    db.enqueue_runner_step(ORG, "run:1", 0, REQUEST, NOW)
        .await
        .unwrap();

    db.purge_expired_observation_runs(NOW).await.unwrap();
    assert!(db
        .outstanding_runner_step(ORG, "run:1")
        .await
        .unwrap()
        .is_none());
}
