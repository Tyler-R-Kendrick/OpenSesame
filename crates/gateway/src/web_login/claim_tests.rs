//! The runner owns its job from the moment it is requested (ADR 0159): the
//! generic rotation consumer is never offered it, the claim is a persisted
//! lease naming the run, and a missing prerequisite parks the job through that
//! claim rather than racing the consumer for it.

use std::sync::atomic::{AtomicBool, Ordering};

use opensesame_connection_broker::{consume_rotation_events, EVENT_ROTATION_REQUESTED};

use super::test_support::*;

async fn claims(world: &World) -> Vec<(String, String)> {
    sqlx::query_as("SELECT job_id, run_id FROM web_login_job_claims")
        .fetch_all(world.state.db.pool())
        .await
        .unwrap_or_default()
}

#[tokio::test]
async fn a_run_is_claimed_by_name_and_never_offered_to_the_generic_consumer() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let done = AtomicBool::new(false);
    let launcher = launcher(&world.state);
    let rung = event(&world, SITE);
    let during = std::sync::Mutex::new(None);
    let (outcome, ()) = tokio::join!(
        async {
            let outcome = launcher
                .rotate(&rung, SITE, &world.org, Some(world.policies[0].clone()))
                .await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(&world.state, &org, &done, |request| {
            let world = &world;
            let during = &during;
            async move {
                if request["step"] == "navigate" {
                    *during.lock().unwrap() = Some(claims(world).await);
                    // The generic consumer is running at the same moment, and
                    // finds nothing of the runner's to take.
                    let bus = world.bus.clone();
                    consume_rotation_events(world.state.connection_broker.as_ref(), &*bus, 50)
                        .await
                        .unwrap();
                }
            }
        }),
    );
    assert!(outcome.succeeded, "{}", outcome.detail);

    let run = world
        .state
        .db
        .list_observation_runs(&org, 10)
        .await
        .unwrap()
        .remove(0);
    let (during, ()) = (during.lock().unwrap().clone().expect("a navigate ran"), ());
    assert_eq!(during.len(), 1, "one claim while the run was in flight");
    assert_eq!(
        during[0].1, run.id,
        "the claim names the run that drives it"
    );
    assert_eq!(during[0].0, run.job_id);

    assert!(
        world.published(EVENT_ROTATION_REQUESTED).await.is_empty(),
        "the request event is the generic consumer's queue, and this job is not its"
    );
    let job = world
        .state
        .connection_broker
        .list_rotation_jobs(&org, 10)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(job.state, "completed", "the consumer parked nothing");
    assert!(
        claims(&world).await.is_empty(),
        "settled: the claim is released"
    );
}

#[tokio::test]
async fn a_missing_prerequisite_parks_the_job_through_its_claim() {
    // No recipe for the site: the run cannot start, and the job says why.
    let world = world(&[], ALLOW_ALL).await;
    let launcher = launcher(&world.state);
    let outcome = launcher
        .rotate(&event(&world, SITE), SITE, &world.org, None)
        .await;
    assert!(!outcome.succeeded);

    let job = world
        .state
        .connection_broker
        .list_rotation_jobs(&world.org_text(), 10)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(job.state, "reconciliation_required");
    assert!(
        !job.detail.unwrap_or_default().contains("sandbox runner"),
        "not the consumer's no-runner parking"
    );
    assert!(
        claims(&world).await.is_empty(),
        "parked: no claim left behind"
    );
    assert!(world
        .state
        .db
        .list_observation_runs(&world.org_text(), 10)
        .await
        .unwrap()
        .is_empty());
}
