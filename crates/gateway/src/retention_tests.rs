use chrono::Utc;
use opensesame_storage::agent_hook_policy::decisions::{
    AgentHookDecisionFilter, NewAgentHookDecision,
};
use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use opensesame_storage::StoredObservationRun;

use super::*;
use crate::app_state::test_demo_state;

const ORG: &str = "org:one";

async fn decision_at(state: &AppState, created_at: &str) {
    state
        .db
        .append_agent_hook_decision(&NewAgentHookDecision {
            organization_id: ORG,
            caller: "operator",
            interception_point: Some("input"),
            decision: "allow",
            escalated: false,
            reason: None,
            policy_version: 0,
            created_at,
        })
        .await
        .unwrap();
}

fn run(id: &str, expires_at: &str) -> StoredObservationRun {
    StoredObservationRun {
        id: id.into(),
        organization_id: ORG.into(),
        job_id: format!("job:{id}"),
        target_origin: "https://example.com".into(),
        tier: "t3".into(),
        control_state: "agent_driving".into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: "principal:alice".into(),
        viewer_key_id: "xkey:1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: expires_at.into(),
        closed_at: None,
        version: 1,
        created_at: "2026-09-01T00:00:00+00:00".into(),
        updated_at: "2026-09-01T00:00:00+00:00".into(),
    }
}

async fn footprint(state: &AppState, id: &str) -> [i64; 3] {
    let mut counts = [0; 3];
    for (slot, sql) in [
        "SELECT COUNT(*) FROM observation_runs WHERE id = ?",
        "SELECT COUNT(*) FROM runner_steps WHERE run_id = ?",
        "SELECT COUNT(*) FROM agent_hook_records WHERE run_id = ?",
    ]
    .into_iter()
    .enumerate()
    {
        counts[slot] = sqlx::query_scalar(sql)
            .bind(id)
            .fetch_one(state.db.pool())
            .await
            .unwrap();
    }
    counts
}

#[tokio::test]
async fn a_pass_trims_old_decisions_and_expired_runs_and_only_those() {
    let state = test_demo_state().await;
    let now = Utc::now();
    let stamp = |days: i64| (now - chrono::Duration::days(days)).to_rfc3339();
    decision_at(&state, &stamp(100)).await;
    decision_at(&state, &stamp(89)).await;
    decision_at(&state, &stamp(1)).await;

    for (id, expires) in [("run:old", stamp(1)), ("run:live", stamp(-6))] {
        state
            .db
            .create_observation_run(&run(id, &expires))
            .await
            .unwrap();
        state
            .db
            .enqueue_runner_step(ORG, id, 0, r#"{"step":"navigate"}"#, &stamp(0))
            .await
            .unwrap();
        state
            .db
            .append_agent_hook_records(&[StoredAgentHookRecord {
                run_id: id.into(),
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
                recorded_at: stamp(0),
            }])
            .await
            .unwrap();
    }

    let report = pass(&state, now, DEFAULT_DECISION_RETENTION_DAYS)
        .await
        .unwrap();
    assert_eq!(report.decisions, 1, "only the one past 90 days");
    assert_eq!(
        (
            report.runs.runs,
            report.runs.steps,
            report.runs.hook_records
        ),
        (1, 1, 1),
        "the run, its queue and its records"
    );
    assert_eq!(footprint(&state, "run:old").await, [0, 0, 0]);
    assert_eq!(footprint(&state, "run:live").await, [1, 1, 1]);
    let kept = state
        .db
        .list_agent_hook_decisions(ORG, &AgentHookDecisionFilter::default(), None, 10)
        .await
        .unwrap();
    assert_eq!(kept.len(), 2);

    // A shorter retention trims more; running again removes nothing.
    assert_eq!(pass(&state, now, 30).await.unwrap().decisions, 1);
    assert_eq!(pass(&state, now, 30).await.unwrap(), PassReport::default());
}

#[test]
fn the_decision_retention_is_a_stated_number_of_days() {
    assert_eq!(parse_days(None), 90);
    assert_eq!(parse_days(Some("7")), 7);
    assert_eq!(parse_days(Some(" 365 ")), 365);
    for bad in ["0", "-3", "forever", "", "3651", "1.5"] {
        assert_eq!(
            parse_days(Some(bad)),
            DEFAULT_DECISION_RETENTION_DAYS,
            "{bad}"
        );
    }
}

#[test]
fn the_environment_names_the_retention() {
    let _guard = crate::app_state::test_env::lock();
    let name = "OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS";
    std::env::remove_var(name);
    assert_eq!(decision_retention_days(), 90);
    std::env::set_var(name, "14");
    assert_eq!(decision_retention_days(), 14);
    std::env::set_var(name, "nonsense");
    assert_eq!(decision_retention_days(), 90);
    std::env::remove_var(name);
}

#[tokio::test]
async fn the_actor_trims_at_startup_without_being_asked() {
    let state = test_demo_state().await;
    let old = (Utc::now() - chrono::Duration::days(200)).to_rfc3339();
    decision_at(&state, &old).await;
    decision_at(&state, &Utc::now().to_rfc3339()).await;

    let actor = tokio::spawn(super::run(state.clone()));
    let mut left = 2;
    for _ in 0..500 {
        left = state
            .db
            .list_agent_hook_decisions(ORG, &AgentHookDecisionFilter::default(), None, 10)
            .await
            .unwrap()
            .len();
        if left == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    actor.abort();
    assert_eq!(left, 1, "the pass at startup removed only the old decision");
}
