//! A run is closed durably before its rotation is settled (ADR 0159): a close
//! that fails is retried with backoff and the job stays unsettled until it
//! lands; one that cannot ever land parks the job for reconciliation, with a
//! detail that says why.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::close::CloseRetry;
use super::test_support::*;

/// A trigger that refuses to close a run: the store is up, reads work, but
/// writing `closed_at` fails — the case the old code logged and went past.
const REFUSE_CLOSE: &str = "CREATE TRIGGER refuse_close BEFORE UPDATE ON observation_runs \
     WHEN NEW.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'closing is refused'); END";

fn retry(attempts: u32, backoff_ms: u64) -> CloseRetry {
    CloseRetry {
        attempts,
        backoff: Duration::from_millis(backoff_ms),
    }
}

async fn job_state(world: &World) -> (String, String) {
    let job = world
        .state
        .connection_broker
        .list_rotation_jobs(&world.org_text(), 10)
        .await
        .unwrap()
        .remove(0);
    (job.state, job.detail.unwrap_or_default())
}

async fn the_run(world: &World) -> opensesame_storage::StoredObservationRun {
    world
        .state
        .db
        .list_observation_runs(&world.org_text(), 10)
        .await
        .unwrap()
        .remove(0)
}

/// Rotate once, with a close that fails until `lift` removes the trigger.
async fn rotate_through_a_failing_close<F, Fut>(
    world: &World,
    close_retry: CloseRetry,
    lift: F,
) -> crate::lifecycle::responders::Outcome
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    sqlx::query(REFUSE_CLOSE)
        .execute(world.state.db.pool())
        .await
        .unwrap();
    let org = world.org_text();
    let done = AtomicBool::new(false);
    let launcher = launcher(&world.state).with_close_retry(close_retry);
    let event = event(world, SITE);
    let (outcome, (), ()) = tokio::join!(
        async {
            let outcome = launcher
                .rotate(&event, SITE, &world.org, Some(world.policies[0].clone()))
                .await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(&world.state, &org, &done, |_| async {}),
        lift(),
    );
    outcome
}

#[tokio::test]
async fn a_close_that_fails_is_retried_and_the_job_is_not_settled_until_it_lands() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let during = std::sync::Mutex::new(Vec::new());
    let outcome = rotate_through_a_failing_close(&world, retry(40, 25), || async {
        // Wait until the run is over and only its close is outstanding: every
        // step has settled, and the job has still not been settled.
        while queued(&world.state.db, &the_run_id(&world).await)
            .await
            .len()
            < COMPLETE_RUN.len()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        during.lock().unwrap().push((
            job_state(&world).await,
            the_run(&world).await.closed_at.is_some(),
        ));
        sqlx::query("DROP TRIGGER refuse_close")
            .execute(world.state.db.pool())
            .await
            .unwrap();
    })
    .await;

    let observed = during.lock().unwrap().clone();
    assert_eq!(observed.len(), 1);
    let ((state, _), closed) = &observed[0];
    assert_eq!(state, "discovering", "not settled while the run is open");
    assert!(!closed);

    assert!(outcome.succeeded, "{}", outcome.detail);
    assert!(the_run(&world).await.closed_at.is_some(), "closed at last");
    assert_eq!(job_state(&world).await.0, "completed");
}

async fn the_run_id(world: &World) -> String {
    let runs = world
        .state
        .db
        .list_observation_runs(&world.org_text(), 10)
        .await
        .unwrap();
    runs.first().map(|run| run.id.clone()).unwrap_or_default()
}

#[tokio::test]
async fn a_close_that_can_never_land_parks_the_job_for_reconciliation() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let outcome = rotate_through_a_failing_close(&world, retry(3, 5), || async {}).await;

    assert!(!outcome.succeeded, "{}", outcome.detail);
    let (state, detail) = job_state(&world).await;
    assert_eq!(state, "reconciliation_required", "{detail}");
    assert!(detail.contains("could not be closed"), "{detail}");
    assert!(
        detail.contains("the change completed"),
        "what the run did is still said: {detail}"
    );
    assert!(
        the_run(&world).await.closed_at.is_none(),
        "left open, for the reaper"
    );
}

#[tokio::test]
async fn the_reaper_closes_the_run_a_failed_close_left_open() {
    let world = world(&[SITE], ALLOW_ALL).await;
    rotate_through_a_failing_close(&world, retry(2, 1), || async {}).await;
    assert!(the_run(&world).await.closed_at.is_none());

    sqlx::query("DROP TRIGGER refuse_close")
        .execute(world.state.db.pool())
        .await
        .unwrap();
    let later = chrono::Utc::now() + chrono::Duration::hours(2);
    let report = super::reaper::sweep(&world.state, later, super::reaper::horizon())
        .await
        .unwrap();
    assert_eq!(report.runs_closed, 1);
    assert!(the_run(&world).await.closed_at.is_some());
}
