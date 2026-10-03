//! The scanner starts a web-login run and moves on (ADR 0159): a tracked task
//! per run, bounded globally and per organization, one per target, the
//! policy lease claimed when the run begins to execute — and the run's own
//! outcome, not the scanner's, on the feed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use opensesame_lifecycle::{EVENT_RENEWAL_DUE, EVENT_RENEWAL_FAILED, EVENT_RENEWAL_SUCCEEDED};

use super::registry::{RunLimits, RunRegistry};
use super::test_support::*;
use crate::app_state::AppState;
use crate::lifecycle::dispatch;

const OTHER_SITE: &str = "https://other.example";
const THIRD_SITE: &str = "https://third.example";

fn bounded(state: &AppState, limits: RunLimits) -> AppState {
    AppState {
        web_login_runs: Arc::new(RunRegistry::new(limits)),
        ..state.clone()
    }
}

async fn jobs(state: &AppState, org: &str) -> Vec<opensesame_connection_broker::RotationJob> {
    state
        .connection_broker
        .list_rotation_jobs(org, 20)
        .await
        .unwrap()
}

/// Drive every run of the organization to its end, then stop.
async fn drive_until_idle(state: &AppState, org: &str) {
    let done = AtomicBool::new(false);
    tokio::join!(drive(state, org, &done, |_| async {}), async {
        state.web_login_runs.idle().await;
        done.store(true, Ordering::SeqCst);
    });
}

#[tokio::test]
async fn the_scanner_starts_the_run_and_reports_nothing_until_the_run_does() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let rung = event(&world, SITE);

    // No browser is answering yet: were the run inline, this would not return.
    tokio::time::timeout(
        Duration::from_secs(10),
        dispatch::publish(&world.state, &rung, Utc::now()),
    )
    .await
    .expect("the scanner starts a run and moves on");
    assert_eq!(world.state.web_login_runs.pending(), 1);
    the_open_run(&world.state.db, &org).await;
    let running = jobs(&world.state, &org).await;
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].state, "discovering");

    // The rung was announced; the outcome was not — a success now would
    // resolve the alert before anything was fixed.
    assert_eq!(world.published(EVENT_RENEWAL_DUE).await.len(), 1);
    assert!(world.published(EVENT_RENEWAL_SUCCEEDED).await.is_empty());
    assert!(world.published(EVENT_RENEWAL_FAILED).await.is_empty());

    // The run ends, and reports for itself.
    drive_until_idle(&world.state, &org).await;
    assert_eq!(jobs(&world.state, &org).await[0].state, "completed");
    let succeeded = world.published(EVENT_RENEWAL_SUCCEEDED).await;
    assert_eq!(succeeded.len(), 1, "one outcome, from the run");
    assert!(world.published(EVENT_RENEWAL_FAILED).await.is_empty());
}

#[tokio::test]
async fn a_scanner_pass_returns_while_a_tenants_run_waits_on_its_browser() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();

    // Nobody answers the browser's queue. Inline, this pass would sit here for
    // the run's whole deadline, and every other tenant's renewals with it.
    let fired = tokio::time::timeout(
        Duration::from_secs(10),
        crate::lifecycle::scanner::pass(&world.state, Utc::now()),
    )
    .await
    .expect("the scanner is not held by a run")
    .unwrap();
    assert!(fired > 0, "the never-rotated policy was due");
    assert_eq!(world.state.web_login_runs.pending(), 1);
    the_open_run(&world.state.db, &org).await;

    // The next pass re-evaluates the same subject and starts nothing new: the
    // rung was claimed, and the run is still in flight.
    crate::lifecycle::scanner::pass(&world.state, Utc::now())
        .await
        .unwrap();
    assert_eq!(world.state.web_login_runs.pending(), 1);
    assert_eq!(jobs(&world.state, &org).await.len(), 1);

    drive_until_idle(&world.state, &org).await;
    assert_eq!(jobs(&world.state, &org).await[0].state, "completed");
}

#[tokio::test]
async fn the_agent_event_names_the_observation_run_and_the_job_apart() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    let run = the_open_run(&world.state.db, &org).await;
    drive_until_idle(&world.state, &org).await;

    let completed = world.published("agent.run.completed").await;
    assert_eq!(completed.len(), 1);
    let data = &completed[0].data;
    assert_eq!(data["run_id"], run.id, "what a person attaches to");
    assert_eq!(data["job_id"], run.job_id, "the rotation job, on its own");
    assert_ne!(data["run_id"], data["job_id"]);
}

#[tokio::test]
async fn a_job_parked_before_any_run_opened_names_no_run() {
    // No recipe for the site: the job parks before a run exists.
    let mut world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    sqlx::query("DELETE FROM web_login_recipes")
        .execute(world.state.db.pool())
        .await
        .unwrap();
    world.state = bounded(&world.state, RunLimits::default());
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    world.state.web_login_runs.idle().await;

    let blocked = world.published("agent.run.blocked").await;
    assert_eq!(blocked.len(), 1);
    assert_eq!(blocked[0].data["run_id"], "unassigned");
    let job = jobs(&world.state, &org).await.remove(0);
    assert_eq!(blocked[0].data["job_id"], job.id);
    assert_eq!(job.state, "reconciliation_required");
    // A parked job is an outcome the run reports too.
    assert_eq!(world.published(EVENT_RENEWAL_FAILED).await.len(), 1);
}

#[tokio::test]
async fn a_second_rung_for_a_target_in_flight_starts_no_second_run() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let first = super::start(&world.state, &event(&world, SITE)).await;
    assert!(first.pending && first.succeeded, "{}", first.detail);
    let second = super::start(&world.state, &event(&world, SITE)).await;
    // Nothing rotated for this rung: it is neither a success to publish nor a
    // started run that will report for it.
    assert!(second.pending && !second.succeeded, "{}", second.detail);
    assert!(
        second.detail.contains("already in flight"),
        "{}",
        second.detail
    );

    drive_until_idle(&world.state, &org).await;
    assert_eq!(jobs(&world.state, &org).await.len(), 1);
    assert_eq!(
        world
            .state
            .db
            .list_observation_runs(&org, 10)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn another_process_cannot_start_the_run_a_policy_lease_covers() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let first = super::start(&world.state, &event(&world, SITE)).await;
    assert!(first.pending);
    // The first process's run is executing (it holds the policy lease) …
    the_open_run(&world.state.db, &org).await;

    // … so a second gateway process, with a registry of its own, starts a task
    // that finds the lease taken and stands down: no second job, no second run.
    let elsewhere = world.another_process();
    let second = super::start(&elsewhere, &event(&world, SITE)).await;
    assert!(second.pending, "its own registry has nothing in flight");
    elsewhere.web_login_runs.idle().await;
    assert_eq!(jobs(&world.state, &org).await.len(), 1);
    assert_eq!(
        world
            .state
            .db
            .list_observation_runs(&org, 10)
            .await
            .unwrap()
            .len(),
        1
    );

    drive_until_idle(&world.state, &org).await;
    assert_eq!(jobs(&world.state, &org).await[0].state, "completed");
}

#[tokio::test]
async fn runs_execute_within_the_global_and_per_organization_bounds() {
    let world = world(&[SITE, OTHER_SITE, THIRD_SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let state = bounded(
        &world.state,
        RunLimits {
            global: 8,
            per_org: 1,
            pending: 64,
        },
    );
    for site in [SITE, OTHER_SITE, THIRD_SITE] {
        let started = super::start(&state, &event(&world, site)).await;
        assert!(started.pending, "{}", started.detail);
    }
    assert_eq!(state.web_login_runs.pending(), 3);

    // One organization, one at a time: the others wait holding nothing — no
    // lease, no job, no run — until their turn.
    the_open_run(&state.db, &org).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(state.web_login_runs.running(), 1);
    assert_eq!(jobs(&state, &org).await.len(), 1);
    assert_eq!(
        state
            .db
            .list_observation_runs(&org, 10)
            .await
            .unwrap()
            .len(),
        1
    );

    drive_until_idle(&state, &org).await;
    let finished = jobs(&world.state, &org).await;
    assert_eq!(finished.len(), 3);
    assert!(
        finished.iter().all(|job| job.state == "completed"),
        "{finished:?}"
    );
}

#[tokio::test]
async fn the_global_bound_holds_across_organizations() {
    let world = world(&[SITE, OTHER_SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let state = bounded(
        &world.state,
        RunLimits {
            global: 1,
            per_org: 4,
            pending: 64,
        },
    );
    for site in [SITE, OTHER_SITE] {
        assert!(super::start(&state, &event(&world, site)).await.pending);
    }
    the_open_run(&state.db, &org).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(state.web_login_runs.running(), 1);
    assert_eq!(
        state
            .db
            .list_observation_runs(&org, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    drive_until_idle(&state, &org).await;
    assert_eq!(jobs(&world.state, &org).await.len(), 2);
}

#[tokio::test]
async fn a_flood_of_due_runs_is_refused_not_remembered() {
    let world = world(&[SITE, OTHER_SITE], ALLOW_ALL).await;
    let state = bounded(
        &world.state,
        RunLimits {
            global: 1,
            per_org: 1,
            pending: 1,
        },
    );
    assert!(super::start(&state, &event(&world, SITE)).await.pending);
    let refused = super::start(&state, &event(&world, OTHER_SITE)).await;
    assert!(!refused.succeeded && !refused.pending);
    assert!(
        refused.detail.contains("too many runs queued"),
        "{}",
        refused.detail
    );
    // The refusal is an outcome the dispatcher publishes: nobody is told the
    // rotation happened.
    state.web_login_runs.abort_all();
    state.web_login_runs.idle().await;
}

#[tokio::test]
async fn a_subject_that_is_not_a_web_login_is_refused_without_a_task() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let mut bad = event(&world, SITE);
    bad.subject.organization_id = "org:not-a-uuid".into();
    let refused = super::start(&world.state, &bad).await;
    assert!(!refused.succeeded && !refused.pending);
    assert!(
        refused.detail.contains("non-canonical"),
        "{}",
        refused.detail
    );
    assert_eq!(world.state.web_login_runs.pending(), 0);

    let mut certificate = event(&world, SITE);
    certificate.subject.kind = opensesame_lifecycle::SubjectKind::Certificate;
    let refused = super::start(&world.state, &certificate).await;
    assert!(!refused.succeeded);
    assert_eq!(world.state.web_login_runs.pending(), 0);
}

#[tokio::test]
async fn a_target_another_replica_holds_is_skipped_and_never_run_twice() {
    use opensesame_connection_broker::rotation::web_login::{
        request_claimed_web_login_rotation, WebLoginClaim,
    };

    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    // A runner on another replica holds SITE: its job and live claim are in
    // the shared database, and its registry is not this process's.
    let elsewhere = WebLoginClaim {
        run_id: "run_elsewhere",
        lease: chrono::Duration::minutes(17),
    };
    request_claimed_web_login_rotation(
        world.state.connection_broker.as_ref(),
        &world.org,
        SITE,
        None,
        &elsewhere,
    )
    .await
    .unwrap();
    assert!(super::run_held(&world.state, &world.org, SITE).await);
    assert!(!super::run_held(&world.state, &world.org, OTHER_SITE).await);

    let launcher = super::WebLoginLauncher::from_state(&world.state);
    let scheduled = launcher
        .rotate(
            &event(&world, SITE),
            SITE,
            &world.org,
            Some(world.policies[0].clone()),
        )
        .await;
    // Held: not a success (nothing rotated, and the holder may never report),
    // and the policy lease is given back rather than left to lapse.
    assert!(
        scheduled.pending && !scheduled.succeeded,
        "{}",
        scheduled.detail
    );
    assert!(
        scheduled.detail.contains("already in flight"),
        "{}",
        scheduled.detail
    );
    let attended = launcher.rotate_attended(&world.org, SITE, "owner").await;
    assert!(
        attended.detail.contains("already in flight"),
        "{}",
        attended.detail
    );

    let held = jobs(&world.state, &org).await;
    assert_eq!(held.len(), 1, "no second job: {held:?}");
    assert_eq!(held[0].state, "discovering");
    let runs = world
        .state
        .db
        .list_observation_runs(&org, 10)
        .await
        .unwrap();
    assert!(runs.is_empty(), "no run was opened: {runs:?}");
}
