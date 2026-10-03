//! What a stopped gateway leaves behind is closed, truthfully (ADR 0159): a
//! run whose task is dropped mid-flight is reconciled after its lease, at
//! startup and by the periodic sweep, and nothing alive is ever touched.

use chrono::Utc;
use opensesame_storage::StoredObservationRun;

use super::reaper::{
    horizon, reconcile_at_startup, sweep, SweepReport, RUN_ORPHANED, RUN_PARKED_EXPIRED,
};
use super::test_support::*;
use opensesame_connection_broker::rotation::web_login::STRANDED_DETAIL;

/// Start a run and wait until it has put a step in front of the driver — a run
/// truly mid-flight, its job `discovering` and its queue claimable.
async fn mid_flight(world: &World) -> StoredObservationRun {
    let org = world.org_text();
    let started = super::start(&world.state, &event(world, SITE)).await;
    assert!(started.pending, "{}", started.detail);
    let run = the_open_run(&world.state.db, &org).await;
    for _ in 0..1000 {
        if !queued(&world.state.db, &run.id).await.is_empty() {
            return run;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    panic!("the run never queued a step");
}

async fn run_row(world: &World, id: &str) -> StoredObservationRun {
    world
        .state
        .db
        .get_observation_run(&world.org_text(), id)
        .await
        .unwrap()
        .unwrap()
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

#[tokio::test]
async fn a_run_killed_mid_flight_is_closed_and_its_job_parked_once_its_lease_has_run_out() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let run = mid_flight(&world).await;
    assert_eq!(job_state(&world).await.0, "discovering");

    // The process dies: the task is dropped where it stands. Nothing is
    // settled, released or announced — the run is open, its step claimable,
    // its job "discovering" for good.
    world.state.web_login_runs.abort_all();
    world.state.web_login_runs.idle().await;
    assert!(run_row(&world, &run.id).await.closed_at.is_none());
    assert_eq!(job_state(&world).await.0, "discovering");

    // A new process comes up. While the dead run's lease could still be
    // running, it touches nothing: the run may belong to another process.
    let restarted = world.another_process();
    assert_eq!(
        sweep(&restarted, Utc::now(), horizon()).await.unwrap(),
        SweepReport::default()
    );
    assert!(run_row(&world, &run.id).await.closed_at.is_none());

    // Once the lease has run out, the run is nobody's.
    let later = Utc::now() + horizon() + chrono::Duration::minutes(1);
    let report = sweep(&restarted, later, horizon()).await.unwrap();
    assert_eq!(
        report,
        SweepReport {
            runs_closed: 1,
            jobs_parked: 1
        }
    );
    let closed = run_row(&world, &run.id).await;
    assert!(closed.closed_at.is_some());
    assert_eq!(closed.control_state, "suspended");
    assert_eq!(closed.blocked_reason.as_deref(), Some(RUN_ORPHANED));
    let (state, detail) = job_state(&world).await;
    assert_eq!(state, "reconciliation_required");
    assert_eq!(detail, STRANDED_DETAIL);
    assert!(
        !detail.contains("not submitted"),
        "a stopped run may have submitted; the job must not say it did not"
    );

    // Its step can no longer be claimed, and the owner is told — by the
    // reaper, since the run that would have told them is gone.
    let claimed = world
        .state
        .db
        .claim_runner_step(
            &org,
            &run.id,
            OWNER,
            &Utc::now().to_rfc3339(),
            &later.to_rfc3339(),
        )
        .await
        .unwrap();
    assert!(claimed.is_none());
    let blocked = world.published("agent.run.blocked").await;
    assert_eq!(blocked.len(), 1);
    assert_eq!(blocked[0].data["run_id"], run.id);
    assert_eq!(blocked[0].data["job_id"], run.job_id);
    assert_eq!(blocked[0].data["owner_principal_id"], OWNER);

    // And it is done once: the next sweep finds nothing.
    assert_eq!(
        sweep(&restarted, later, horizon()).await.unwrap(),
        SweepReport::default()
    );
    assert_eq!(world.published("agent.run.blocked").await.len(), 1);
}

#[tokio::test]
async fn startup_reconciliation_closes_what_the_last_process_left_before_the_scanner_starts() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let run = mid_flight(&world).await;
    world.state.web_login_runs.abort_all();
    world.state.web_login_runs.idle().await;

    // The gateway was down for an hour: back-date what it left.
    let hour_ago = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
    sqlx::query("UPDATE observation_runs SET created_at = ?")
        .bind(&hour_ago)
        .execute(world.state.db.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE rotation_jobs SET updated_at = ?")
        .bind(&hour_ago)
        .execute(world.state.db.pool())
        .await
        .unwrap();
    // The claim is a lease; the process that held it has been gone an hour.
    sqlx::query("UPDATE web_login_job_claims SET claimed_at = ?, lease_expires_at = ?")
        .bind(&hour_ago)
        .bind(&hour_ago)
        .execute(world.state.db.pool())
        .await
        .unwrap();

    reconcile_at_startup(&world.another_process()).await;
    assert!(run_row(&world, &run.id).await.closed_at.is_some());
    assert_eq!(job_state(&world).await.0, "reconciliation_required");
}

#[tokio::test]
async fn a_run_that_is_alive_is_never_touched() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let run = mid_flight(&world).await;
    // Even a sweep that looks far into the future leaves it alone until the
    // lease says otherwise; and inside the lease nothing is touched at all.
    assert_eq!(
        sweep(&world.state, Utc::now(), horizon()).await.unwrap(),
        SweepReport::default()
    );
    assert!(run_row(&world, &run.id).await.closed_at.is_none());
    assert_eq!(job_state(&world).await.0, "discovering");

    let done = std::sync::atomic::AtomicBool::new(false);
    tokio::join!(drive(&world.state, &org, &done, |_| async {}), async {
        world.state.web_login_runs.idle().await;
        done.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    assert_eq!(job_state(&world).await.0, "completed");
}

#[tokio::test]
async fn a_run_a_person_holds_under_a_live_lease_is_not_stranded() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let run = mid_flight(&world).await;
    world.state.web_login_runs.abort_all();
    world.state.web_login_runs.idle().await;
    sqlx::query(
        "UPDATE observation_runs SET control_state = 'human_driving', lease_holder = ?, \
         lease_expires_at = '2999-01-01T00:00:00+00:00'",
    )
    .bind(OWNER)
    .execute(world.state.db.pool())
    .await
    .unwrap();

    let later = Utc::now() + horizon() + chrono::Duration::minutes(1);
    let report = sweep(&world.state, later, horizon()).await.unwrap();
    assert_eq!(
        report.runs_closed, 0,
        "the person's lease has its own clock"
    );
    let held = run_row(&world, &run.id).await;
    assert!(held.closed_at.is_none());
    assert_eq!(held.control_state, "human_driving");
}

#[tokio::test]
async fn a_run_parked_for_a_person_is_closed_quietly_once_it_has_expired() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let run = mid_flight(&world).await;
    world.state.web_login_runs.abort_all();
    world.state.web_login_runs.idle().await;
    // The run had already parked for a person (and announced itself doing so).
    sqlx::query("UPDATE observation_runs SET control_state = 'awaiting_human'")
        .execute(world.state.db.pool())
        .await
        .unwrap();

    let later = Utc::now() + horizon() + chrono::Duration::minutes(1);
    let report = sweep(&world.state, later, horizon()).await.unwrap();
    assert_eq!(report.runs_closed, 1);
    let closed = run_row(&world, &run.id).await;
    assert!(closed.closed_at.is_some());
    assert_eq!(closed.blocked_reason.as_deref(), Some(RUN_PARKED_EXPIRED));
    assert!(
        world.published("agent.run.blocked").await.is_empty(),
        "the run announced its own parking; closing it is not a new emergency"
    );
}

#[tokio::test]
async fn a_job_stranded_before_its_run_opened_is_parked_too() {
    // A crash between `Scheduled → Discovering` and the run's first write
    // leaves a job with no run at all.
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let bus = world.state.task_bus.read().await;
    let job = opensesame_connection_broker::request_rotation(
        world.state.connection_broker.as_ref(),
        bus.as_ref(),
        opensesame_connection_broker::RotationTarget::WebLogin {
            origin: SITE.into(),
        },
        None,
        &org,
        None,
    )
    .await
    .unwrap();
    drop(bus);
    opensesame_connection_broker::rotation::web_login::begin_web_login_rotation(
        world.state.connection_broker.as_ref(),
        &world.org,
        &job.id,
        &opensesame_connection_broker::rotation::web_login::WebLoginClaim {
            run_id: "run_never_opened",
            lease: horizon(),
        },
    )
    .await
    .unwrap();

    let later = Utc::now() + horizon() + chrono::Duration::minutes(1);
    let report = sweep(&world.state, later, horizon()).await.unwrap();
    assert_eq!(
        report,
        SweepReport {
            runs_closed: 0,
            jobs_parked: 1
        }
    );
    assert_eq!(job_state(&world).await.0, "reconciliation_required");
}

#[tokio::test]
async fn the_periodic_actor_closes_what_it_finds_on_its_own_clock() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let run = mid_flight(&world).await;
    world.state.web_login_runs.abort_all();
    world.state.web_login_runs.idle().await;
    let hour_ago = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
    sqlx::query("UPDATE observation_runs SET created_at = ?")
        .bind(&hour_ago)
        .execute(world.state.db.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE rotation_jobs SET updated_at = ?")
        .bind(&hour_ago)
        .execute(world.state.db.pool())
        .await
        .unwrap();
    // The claim is a lease; the process that held it has been gone an hour.
    sqlx::query("UPDATE web_login_job_claims SET claimed_at = ?, lease_expires_at = ?")
        .bind(&hour_ago)
        .bind(&hour_ago)
        .execute(world.state.db.pool())
        .await
        .unwrap();

    // The actor is started the way `lib.rs` starts it, on a one-second tick.
    let actor = {
        let _guard = crate::app_state::test_env::lock();
        std::env::set_var("OPENSESAME_WEB_LOGIN_SWEEP_SECONDS", "1");
        let actor = tokio::spawn(super::reaper::run(world.another_process()));
        std::env::remove_var("OPENSESAME_WEB_LOGIN_SWEEP_SECONDS");
        actor
    };
    // The sweep closes the run and then parks the job; wait for both.
    let mut swept = false;
    for _ in 0..600 {
        if run_row(&world, &run.id).await.closed_at.is_some()
            && job_state(&world).await.0 == "reconciliation_required"
        {
            swept = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    actor.abort();
    assert!(swept, "the sweep never ran");
    assert_eq!(job_state(&world).await.0, "reconciliation_required");
}
