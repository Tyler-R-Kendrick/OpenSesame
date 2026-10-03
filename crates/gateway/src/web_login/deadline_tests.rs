//! A run is bounded end to end, not only step by step (ADR 0156): the reaper's
//! horizon is the policy lease, so a live run must never outlast it — and a
//! hook waiting on a person's approval is not a step.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use opensesame_agent_hooks::sdk::{ApprovalRequest, ApprovalResolution, ApprovalResolver};

use super::settle::overdue;
use super::test_support::*;
use super::{ApprovalResolverFactory, RunTiming, WebLoginLauncher};
use opensesame_connection_broker::rotation::web_login::WebLoginSettlement;

/// An approval seam that never answers.
struct NobodyAnswers;

#[async_trait]
impl ApprovalResolver for NobodyAnswers {
    async fn resolve(&self, _request: ApprovalRequest<'_>) -> ApprovalResolution {
        std::future::pending().await
    }
}

#[tokio::test]
async fn a_run_waiting_on_an_approval_nobody_gives_is_stopped_at_its_deadline() {
    // The default policy escalates every tool, so the first verb waits on the
    // approval seam — before any step is enqueued.
    let world = world(&[SITE], r#"{"version":1}"#).await;
    let org = world.org_text();
    let factory: ApprovalResolverFactory = Arc::new(|| Box::new(NobodyAnswers));
    let launcher =
        WebLoginLauncher::new(world.state.clone(), Some(factory)).with_timing(RunTiming {
            step_deadline: Duration::from_secs(30),
            poll: Duration::from_millis(5),
            run_deadline: Duration::from_millis(300),
        });

    let started = Instant::now();
    let outcome = launcher
        .rotate(
            &event(&world, SITE),
            SITE,
            &world.org,
            Some(world.policies[0].clone()),
        )
        .await;
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "the run was not bounded"
    );
    assert!(!outcome.succeeded, "{}", outcome.detail);

    let job = world
        .state
        .connection_broker
        .list_rotation_jobs(&org, 10)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(job.state, "reconciliation_required");
    let detail = job.detail.unwrap_or_default();
    assert!(detail.starts_with("not submitted"), "{detail}");
    assert!(detail.contains("past its deadline"), "{detail}");

    let run = world
        .state
        .db
        .list_observation_runs(&org, 10)
        .await
        .unwrap()
        .remove(0);
    assert!(run.closed_at.is_some(), "an overdue run is closed");
    assert!(queued(&world.state.db, &run.id).await.is_empty());
}

#[test]
fn an_overdue_run_says_only_what_is_known_about_the_site() {
    assert!(matches!(
        overdue(false),
        WebLoginSettlement::NotSubmitted(detail) if detail.contains("past its deadline")
    ));
    let WebLoginSettlement::Reconcile(detail) = overdue(true) else {
        panic!("a submit that went out is a reconciliation");
    };
    assert!(detail.contains("may have taken the change"), "{detail}");
}
