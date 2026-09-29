//! The web-login runner's tables (ADR 0076, ADR 0150): only a trusted,
//! unexpired recipe is replayable, hook records are append-only, and a
//! settled step's outcome can be narrowed to what the executor accepted.

use opensesame_storage::web_login_runs::{StoredAgentHookRecord, StoredWebLoginRecipe};
use opensesame_storage::{Db, StoredObservationRun};

const ORG: &str = "org:one";
const ORIGIN: &str = "https://example.com";
const NOW: &str = "2026-08-31T00:00:00+00:00";

fn recipe(trust: &str, expires_at: &str) -> StoredWebLoginRecipe {
    StoredWebLoginRecipe {
        organization_id: ORG.into(),
        origin: ORIGIN.into(),
        recipe_id: "rcp_1".into(),
        trust: trust.into(),
        recipe_json: r#"{"change_url":"https://example.com/.well-known/change-password"}"#.into(),
        expires_at: expires_at.into(),
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

fn record(sequence: i64) -> StoredAgentHookRecord {
    StoredAgentHookRecord {
        run_id: "run:1".into(),
        organization_id: ORG.into(),
        sequence,
        interception_point: "pre_tool_call".into(),
        decision: "deny".into(),
        escalated: true,
        reason: Some("opensesame:tool_requires_approval".into()),
        decided_by: Some(0),
        input_identity: Some("sha256:00".into()),
        enforced_identity: Some("sha256:00".into()),
        policy_version: 2,
        recorded_at: NOW.into(),
    }
}

#[tokio::test]
async fn only_a_trusted_unexpired_recipe_is_replayable() {
    let db = Db::connect_memory().await.unwrap();
    let read = |db: Db| async move {
        db.replayable_web_login_recipe(ORG, ORIGIN, NOW)
            .await
            .unwrap()
    };
    assert_eq!(read(db.clone()).await, None, "no recipe at all");

    db.put_web_login_recipe(&recipe("candidate", "2027-01-01T00:00:00+00:00"))
        .await
        .unwrap();
    assert_eq!(read(db.clone()).await, None, "a candidate is a hypothesis");

    db.put_web_login_recipe(&recipe("canary_verified", "2026-01-01T00:00:00+00:00"))
        .await
        .unwrap();
    assert_eq!(
        read(db.clone()).await,
        None,
        "an expired recipe is not trusted"
    );

    db.put_web_login_recipe(&recipe("canary_verified", "2027-01-01T00:00:00+00:00"))
        .await
        .unwrap();
    let found = read(db.clone()).await.expect("a verified recipe replays");
    assert_eq!(found.trust, "canary_verified");
    assert_eq!(
        db.replayable_web_login_recipe("org:two", ORIGIN, NOW)
            .await
            .unwrap(),
        None,
        "recipes are per organization"
    );

    let mut unknown = recipe("trusted_because_i_said_so", "2027-01-01T00:00:00+00:00");
    unknown.origin = "https://other.example".into();
    assert!(db.put_web_login_recipe(&unknown).await.is_err());
}

#[tokio::test]
async fn hook_records_are_append_only_and_ordered() {
    let db = Db::connect_memory().await.unwrap();
    db.append_agent_hook_records(&[record(1), record(0)])
        .await
        .unwrap();
    let stored = db.agent_hook_records(ORG, "run:1").await.unwrap();
    assert_eq!(
        stored.iter().map(|r| r.sequence).collect::<Vec<_>>(),
        [0, 1]
    );
    assert!(stored[0].escalated);

    // A repeated sequence is refused, and the batch it arrived in with it.
    assert!(db
        .append_agent_hook_records(&[record(2), record(1)])
        .await
        .is_err());
    assert_eq!(db.agent_hook_records(ORG, "run:1").await.unwrap().len(), 2);
    assert!(db
        .agent_hook_records("org:two", "run:1")
        .await
        .unwrap()
        .is_empty());

    let mut prose = record(3);
    prose.decision = "maybe".into();
    assert!(db.append_agent_hook_records(&[prose]).await.is_err());
}

#[tokio::test]
async fn only_a_settled_outcome_is_rewritten() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&StoredObservationRun {
        id: "run:1".into(),
        organization_id: ORG.into(),
        job_id: "job:1".into(),
        target_origin: ORIGIN.into(),
        tier: "t3".into(),
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
    })
    .await
    .unwrap();
    db.enqueue_runner_step(
        ORG,
        "run:1",
        0,
        r#"{"step":"read_dom_redacted","strip":[]}"#,
        NOW,
    )
    .await
    .unwrap();
    let narrowed = r#"{"outcome":"dom","text":"[redacted]","epoch":1}"#;
    assert!(!db
        .replace_settled_runner_step_outcome(ORG, "run:1", 0, narrowed)
        .await
        .unwrap());

    db.claim_runner_step(ORG, "run:1", "alice", NOW, "2026-08-31T00:02:00+00:00")
        .await
        .unwrap()
        .unwrap();
    db.settle_runner_step(
        ORG,
        "run:1",
        0,
        "alice",
        r#"{"outcome":"dom","text":"raw","epoch":1}"#,
        NOW,
    )
    .await
    .unwrap();
    assert!(db
        .replace_settled_runner_step_outcome(ORG, "run:1", 0, narrowed)
        .await
        .unwrap());
    let step = db.get_runner_step(ORG, "run:1", 0).await.unwrap().unwrap();
    assert_eq!(step.outcome_json.as_deref(), Some(narrowed));
    assert!(db
        .replace_settled_runner_step_outcome(ORG, "run:1", 0, "")
        .await
        .is_err());
}
