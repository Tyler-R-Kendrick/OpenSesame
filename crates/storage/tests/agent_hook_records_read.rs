//! Reading a hosted run's hook records back (ADR 0150): pages by `sequence`,
//! a count-and-verdict summary, tenancy, and the rule that a run opened with
//! no viewer key takes no sealed event (ADR 0081 §9).

use opensesame_storage::agent_hook_records::{AgentHookRecordSummary, HOOK_RECORD_PAGE_LIMIT};
use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use opensesame_storage::{Db, ObservationAppend, StoredObservationRun, NO_VIEWER_KEY_PREFIX};

const ORG: &str = "org:one";
const NOW: &str = "2026-08-31T00:00:00+00:00";

fn record(run: &str, sequence: i64, decision: &str, escalated: bool) -> StoredAgentHookRecord {
    StoredAgentHookRecord {
        run_id: run.into(),
        organization_id: ORG.into(),
        sequence,
        interception_point: "pre_tool_call".into(),
        decision: decision.into(),
        escalated,
        reason: Some("opensesame:tool_requires_approval".into()),
        decided_by: Some(0),
        input_identity: Some("sha256:00".into()),
        enforced_identity: Some("sha256:00".into()),
        policy_version: 2,
        recorded_at: NOW.into(),
    }
}

fn run(id: &str, viewer_key_id: &str) -> StoredObservationRun {
    StoredObservationRun {
        id: id.into(),
        organization_id: ORG.into(),
        job_id: "job:1".into(),
        target_origin: "https://example.com".into(),
        tier: "t3".into(),
        control_state: "agent_driving".into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: "user:alice".into(),
        viewer_key_id: viewer_key_id.into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2026-12-31T00:00:00+00:00".into(),
        closed_at: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[tokio::test]
async fn records_page_forward_by_sequence_and_stay_in_their_tenant() {
    let db = Db::connect_memory().await.unwrap();
    db.create_observation_run(&run("run:1", "xkey:viewer-1"))
        .await
        .unwrap();
    let rows: Vec<_> = (0..5).map(|n| record("run:1", n, "allow", false)).collect();
    db.append_agent_hook_records(&rows).await.unwrap();

    let first = db
        .agent_hook_records_after(ORG, "run:1", -1, 2)
        .await
        .unwrap();
    assert_eq!(first.iter().map(|r| r.sequence).collect::<Vec<_>>(), [0, 1]);
    let rest = db
        .agent_hook_records_after(ORG, "run:1", 1, 10)
        .await
        .unwrap();
    assert_eq!(
        rest.iter().map(|r| r.sequence).collect::<Vec<_>>(),
        [2, 3, 4]
    );
    assert!(db
        .agent_hook_records_after(ORG, "run:1", 4, 10)
        .await
        .unwrap()
        .is_empty());
    // A page is never empty-by-limit, and never over the page limit.
    assert_eq!(
        db.agent_hook_records_after(ORG, "run:1", -1, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.agent_hook_records_after(ORG, "run:1", -1, HOOK_RECORD_PAGE_LIMIT * 10)
            .await
            .unwrap()
            .len(),
        5
    );
    assert!(db
        .agent_hook_records_after("org:two", "run:1", -1, 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn the_summary_counts_verdicts_and_nothing_else() {
    let db = Db::connect_memory().await.unwrap();
    assert_eq!(
        db.agent_hook_record_summary(ORG, "run:none").await.unwrap(),
        AgentHookRecordSummary::default()
    );
    for id in ["run:1", "run:2"] {
        db.create_observation_run(&run(id, "xkey:viewer-1"))
            .await
            .unwrap();
    }
    db.append_agent_hook_records(&[
        record("run:1", 0, "allow", false),
        record("run:1", 1, "deny", true),
        record("run:1", 2, "transform", false),
        record("run:1", 3, "deny", false),
        record("run:2", 0, "allow", false),
    ])
    .await
    .unwrap();
    assert_eq!(
        db.agent_hook_record_summary(ORG, "run:1").await.unwrap(),
        AgentHookRecordSummary {
            count: 4,
            allow: 1,
            deny: 2,
            transform: 1,
            escalated: 1,
            last_sequence: Some(3),
        }
    );
    assert_eq!(
        db.agent_hook_record_summary("org:two", "run:1")
            .await
            .unwrap()
            .count,
        0
    );
}

#[tokio::test]
async fn a_run_with_no_viewer_key_takes_no_sealed_event() {
    let db = Db::connect_memory().await.unwrap();
    let keyless = format!("{NO_VIEWER_KEY_PREFIX}hook-records-only");
    db.create_observation_run(&run("run:keyless", &keyless))
        .await
        .unwrap();
    db.create_observation_run(&run("run:keyed", "xkey:viewer-1"))
        .await
        .unwrap();
    let append = |run_id| ObservationAppend {
        organization_id: ORG,
        run_id,
        lane: "action",
        of_step: None,
        layout_epoch: None,
        payload: &[1, 2, 3],
        recorded_at: NOW,
    };
    let refused = db
        .append_observation_event(&append("run:keyless"))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("no viewer key"), "{refused}");
    assert!(db
        .read_observation_events(ORG, "run:keyless", -1, 10)
        .await
        .unwrap()
        .is_empty());
    let after = db
        .get_observation_run(ORG, "run:keyless")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.next_seq, 0, "the cursor did not move");

    // A run that does name a key is unaffected.
    assert_eq!(
        db.append_observation_event(&append("run:keyed"))
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn a_record_needs_a_run_in_its_organization_and_goes_with_it() {
    let db = Db::connect_memory().await.unwrap();
    // No such run: nothing for the record to belong to (migration 0053).
    assert!(db
        .append_agent_hook_records(&[record("run:never", 0, "allow", false)])
        .await
        .is_err());
    // The run exists, but in another organization than the record claims.
    db.create_observation_run(&run("run:1", "xkey:viewer-1"))
        .await
        .unwrap();
    let mut foreign = record("run:1", 0, "allow", false);
    foreign.organization_id = "org:two".into();
    assert!(db.append_agent_hook_records(&[foreign]).await.is_err());

    // A refused batch leaves none of itself behind.
    let batch = [
        record("run:1", 0, "allow", false),
        record("run:never", 1, "allow", false),
    ];
    assert!(db.append_agent_hook_records(&batch).await.is_err());
    assert!(db
        .agent_hook_records(ORG, "run:1")
        .await
        .unwrap()
        .is_empty());

    db.append_agent_hook_records(&[record("run:1", 0, "allow", false)])
        .await
        .unwrap();
    // However the run is removed, its records go with it.
    sqlx::query("DELETE FROM observation_runs WHERE id = 'run:1'")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db
        .agent_hook_records(ORG, "run:1")
        .await
        .unwrap()
        .is_empty());
}
