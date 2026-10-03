//! The agent-hooks decision audit (ADR 0159, migration 0046): append-only,
//! value-blind by shape, paginated newest first, filterable, and trimmed by
//! retention.

use opensesame_storage::agent_hook_policy::decisions::{
    AgentHookDecisionFilter, NewAgentHookDecision, MAX_DECISION_PAGE,
};
use opensesame_storage::Db;

const ORG: &str = "org:one";
const NOW: &str = "2026-09-01T00:00:00+00:00";

fn decision<'a>(
    org: &'a str,
    point: Option<&'a str>,
    verdict: &'a str,
) -> NewAgentHookDecision<'a> {
    NewAgentHookDecision {
        organization_id: org,
        caller: "operator",
        interception_point: point,
        decision: verdict,
        escalated: false,
        reason: None,
        policy_version: 1,
        created_at: NOW,
    }
}

#[tokio::test]
async fn a_decision_round_trips_and_pages_newest_first() {
    let db = Db::connect_memory().await.unwrap();
    for point in ["input", "pre_tool_call", "output"] {
        db.append_agent_hook_decision(&decision(ORG, Some(point), "allow"))
            .await
            .unwrap();
    }
    let all = db
        .list_agent_hook_decisions(ORG, &AgentHookDecisionFilter::default(), None, 10)
        .await
        .unwrap();
    let points: Vec<_> = all
        .iter()
        .map(|row| row.interception_point.as_deref().unwrap())
        .collect();
    assert_eq!(points, ["output", "pre_tool_call", "input"]);
    assert!(all.windows(2).all(|pair| pair[0].id > pair[1].id));

    // A cursor resumes where the page ended, even after another append.
    let first = db
        .list_agent_hook_decisions(ORG, &AgentHookDecisionFilter::default(), None, 2)
        .await
        .unwrap();
    assert_eq!(first.len(), 2);
    db.append_agent_hook_decision(&decision(ORG, Some("input"), "allow"))
        .await
        .unwrap();
    let rest = db
        .list_agent_hook_decisions(
            ORG,
            &AgentHookDecisionFilter::default(),
            Some(first[1].id),
            2,
        )
        .await
        .unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].interception_point.as_deref(), Some("input"));
    assert!(rest[0].id < first[1].id);
}

#[tokio::test]
async fn a_listing_is_scoped_to_its_organization_and_narrowed_by_its_filter() {
    let db = Db::connect_memory().await.unwrap();
    let mut denied = decision(ORG, Some("pre_tool_call"), "deny");
    denied.escalated = true;
    denied.reason = Some("opensesame:tool_requires_approval");
    denied.caller = "principal:alice";
    denied.policy_version = 4;
    db.append_agent_hook_decision(&denied).await.unwrap();
    db.append_agent_hook_decision(&decision(ORG, Some("output"), "transform"))
        .await
        .unwrap();
    db.append_agent_hook_decision(&decision("org:two", Some("output"), "deny"))
        .await
        .unwrap();
    // A body no point could be read from is recorded with none.
    db.append_agent_hook_decision(&decision(ORG, None, "deny"))
        .await
        .unwrap();

    let list = |filter: AgentHookDecisionFilter| {
        let db = db.clone();
        async move {
            db.list_agent_hook_decisions(ORG, &filter, None, 50)
                .await
                .unwrap()
        }
    };
    assert_eq!(list(AgentHookDecisionFilter::default()).await.len(), 3);
    let by_decision = list(AgentHookDecisionFilter {
        decision: Some("deny".into()),
        ..Default::default()
    })
    .await;
    assert_eq!(
        by_decision.len(),
        2,
        "the other organization's deny is not ours"
    );
    let escalated = list(AgentHookDecisionFilter {
        escalated: Some(true),
        interception_point: Some("pre_tool_call".into()),
        caller: Some("principal:alice".into()),
        reason: Some("opensesame:tool_requires_approval".into()),
        policy_version: Some(4),
        ..Default::default()
    })
    .await;
    assert_eq!(escalated.len(), 1);
    assert!(escalated[0].escalated);
    let bounded = list(AgentHookDecisionFilter {
        since: Some("2026-09-01T00:00:00+00:00".into()),
        until: Some("2026-09-01T00:00:00+00:00".into()),
        ..Default::default()
    })
    .await;
    assert!(bounded.is_empty(), "until is exclusive");
    let sql_shaped = list(AgentHookDecisionFilter {
        caller: Some("operator' OR '1'='1".into()),
        ..Default::default()
    })
    .await;
    assert!(sql_shaped.is_empty(), "a filter is bound, never spliced");
}

#[tokio::test]
async fn a_page_is_never_larger_than_the_cap() {
    let db = Db::connect_memory().await.unwrap();
    db.append_agent_hook_decision(&decision(ORG, Some("input"), "allow"))
        .await
        .unwrap();
    let rows = db
        .list_agent_hook_decisions(
            ORG,
            &AgentHookDecisionFilter::default(),
            None,
            MAX_DECISION_PAGE * 10,
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    let none = db
        .list_agent_hook_decisions(ORG, &AgentHookDecisionFilter::default(), None, -5)
        .await
        .unwrap();
    assert_eq!(none.len(), 1, "a non-positive limit still returns one row");
}

#[tokio::test]
async fn the_schema_refuses_what_a_decision_cannot_be() {
    let db = Db::connect_memory().await.unwrap();
    for bad in [
        decision(ORG, Some("not_a_point"), "allow"),
        decision(ORG, Some("input"), "maybe"),
        decision("", Some("input"), "allow"),
    ] {
        assert!(db.append_agent_hook_decision(&bad).await.is_err());
    }
    let mut negative = decision(ORG, Some("input"), "allow");
    negative.policy_version = -1;
    assert!(db.append_agent_hook_decision(&negative).await.is_err());
}

#[tokio::test]
async fn a_decision_is_append_only_and_only_retention_removes_it() {
    let db = Db::connect_memory().await.unwrap();
    let id = db
        .append_agent_hook_decision(&decision(ORG, Some("input"), "deny"))
        .await
        .unwrap();
    let rewrite = sqlx::query("UPDATE agent_hook_decisions SET decision = 'allow' WHERE id = ?")
        .bind(id)
        .execute(db.pool())
        .await;
    assert!(rewrite.is_err(), "a verdict is never rewritten");

    let mut old = decision(ORG, Some("output"), "allow");
    old.created_at = "2026-01-01T00:00:00+00:00";
    db.append_agent_hook_decision(&old).await.unwrap();
    let removed = db
        .purge_agent_hook_decisions("2026-06-01T00:00:00+00:00")
        .await
        .unwrap();
    assert_eq!(removed, 1);
    let kept = db
        .list_agent_hook_decisions(ORG, &AgentHookDecisionFilter::default(), None, 10)
        .await
        .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].id, id);
    assert_eq!(
        db.purge_agent_hook_decisions("2026-06-01T00:00:00+00:00")
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn decisions_never_reach_the_outbox() {
    let db = Db::connect_memory().await.unwrap();
    db.append_agent_hook_decision(&decision(ORG, Some("input"), "allow"))
        .await
        .unwrap();
    assert_eq!(db.count_unpublished_outbox().await.unwrap(), 0);
}
