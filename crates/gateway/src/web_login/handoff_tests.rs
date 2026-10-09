//! A person asking for the page mid-run (ADR 0081 §6-§7), end to end: the
//! whole launcher, the real step queue, the persisted control state the
//! control routes write. The executor keeps a lease of its own; these tests
//! are the proof it is not the only one that decides.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use opensesame_session_observe::HandoffOutcome;
use opensesame_storage::StoredObservationRun;

use super::control::HANDOFF_PARKED;
use super::test_support::*;

/// Run a rotation against a driver that, on the `nth` claim of `step`, has a
/// person ask for the page. Returns the outcome and what the person was told.
async fn rotate_with_handoff_at(
    world: &World,
    step: &'static str,
    nth: usize,
) -> (
    crate::lifecycle::responders::Outcome,
    Option<HandoffOutcome>,
) {
    let org = world.org_text();
    let done = AtomicBool::new(false);
    let seen = AtomicUsize::new(0);
    let told = std::sync::Mutex::new(None);
    let launcher = launcher(&world.state);
    let event = event(world, SITE);
    let (outcome, ()) = tokio::join!(
        async {
            let outcome = launcher
                .rotate(&event, SITE, &world.org, Some(world.policies[0].clone()))
                .await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(&world.state, &org, &done, |request| {
            let asked = request["step"] == step && seen.fetch_add(1, Ordering::SeqCst) + 1 == nth;
            let db = world.state.db.clone();
            let org = org.clone();
            let told = &told;
            async move {
                if asked {
                    let run = the_open_run(&db, &org).await;
                    *told.lock().unwrap() = request_handoff(&db, &org, &run.id).await;
                }
            }
        }),
    );
    let told = *told.lock().unwrap();
    (outcome, told)
}

async fn the_run(world: &World) -> StoredObservationRun {
    let runs = world
        .state
        .db
        .list_observation_runs(&world.org_text(), 10)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    runs.into_iter().next().unwrap()
}

async fn the_job(world: &World) -> opensesame_connection_broker::RotationJob {
    let jobs = world
        .state
        .connection_broker
        .list_rotation_jobs(&world.org_text(), 10)
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    jobs.into_iter().next().unwrap()
}

#[tokio::test]
async fn a_handoff_between_steps_parks_the_run_and_nothing_more_is_enqueued() {
    let world = world(&[SITE], ALLOW_ALL).await;
    // The person asks while the driver is filling the first field.
    let (outcome, told) = rotate_with_handoff_at(&world, "fill_credential", 1).await;
    assert_eq!(told, Some(HandoffOutcome::Accepted));
    assert!(!outcome.succeeded, "{}", outcome.detail);

    let run = the_run(&world).await;
    let steps = queued(&world.state.db, &run.id).await;
    assert_eq!(
        steps,
        [
            "navigate",
            "wait_for",
            "generate_candidate",
            "seal_candidate",
            "fill_credential"
        ],
        "the step in flight settled; the next one was never enqueued"
    );
    assert_eq!(run.control_state, "awaiting_human");
    assert_eq!(run.blocked_reason.as_deref(), Some(HANDOFF_PARKED));
    assert!(run.closed_at.is_none(), "left open: the person can take it");

    // Nothing was submitted, and the job says so and says why it stopped.
    let job = the_job(&world).await;
    assert_eq!(job.state, "reconciliation_required");
    let detail = job.detail.unwrap_or_default();
    assert!(detail.starts_with("not submitted"), "{detail}");
    assert!(detail.contains("parked at a safe point"), "{detail}");

    // While the page is parked or a person holds it, nothing is queued for
    // the browser and nothing can be claimed.
    let org = world.org_text();
    let db = &world.state.db;
    assert!(db
        .enqueue_runner_step(&org, &run.id, 99, "{}", "2026-09-01T00:00:00+00:00")
        .await
        .is_err());
    sqlx::query(
        "UPDATE observation_runs SET control_state = 'human_driving', \
         lease_holder = ?, lease_expires_at = '2999-01-01T00:00:00+00:00'",
    )
    .bind(OWNER)
    .execute(db.pool())
    .await
    .unwrap();
    assert!(db
        .enqueue_runner_step(&org, &run.id, 99, "{}", "2026-09-01T00:00:00+00:00")
        .await
        .is_err());
    assert!(db
        .claim_runner_step(
            &org,
            &run.id,
            OWNER,
            "2026-09-01T00:00:00+00:00",
            "2999-01-01T00:00:00+00:00"
        )
        .await
        .unwrap()
        .is_none());
    // The failed run backs the policy off like any other.
    let policy = world
        .state
        .connection_broker
        .list_rotation_policies(&org)
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.id == world.policies[0].id)
        .unwrap();
    assert_eq!(policy.attempts, 1);
}

#[tokio::test]
async fn a_handoff_inside_the_critical_section_parks_only_after_the_submit() {
    let world = world(&[SITE], ALLOW_ALL).await;
    // The person asks the moment the driver is handed the presence assertion:
    // the span between it and the submit is open.
    let (outcome, told) = rotate_with_handoff_at(&world, "assert_present", 1).await;
    assert_eq!(
        told,
        Some(HandoffOutcome::Queued),
        "asked inside the span: queued, not accepted"
    );
    assert!(!outcome.succeeded, "{}", outcome.detail);

    let run = the_run(&world).await;
    let steps = queued(&world.state.db, &run.id).await;
    assert_eq!(
        steps,
        [
            "navigate",
            "wait_for",
            "generate_candidate",
            "seal_candidate",
            "fill_credential",
            "fill_credential",
            "fill_credential",
            "assert_present",
            "submit"
        ],
        "the submit followed its assertion; the verification never went out"
    );
    assert_eq!(run.control_state, "awaiting_human");
    assert_eq!(run.quiescence, "quiescent");
    assert!(!run.handoff_queued);
    assert!(run.closed_at.is_none());

    // The site took the submit, so this is a reconciliation, not a clean
    // block — and it says why the run stopped.
    let job = the_job(&world).await;
    assert_eq!(job.state, "reconciliation_required");
    let detail = job.detail.unwrap_or_default();
    assert!(!detail.starts_with("not submitted"), "{detail}");
    assert!(detail.contains("submitted"), "{detail}");
    assert!(detail.contains("parked at a safe point"), "{detail}");
}

#[tokio::test]
async fn a_run_nobody_asks_for_completes_and_closes_as_before() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let done = AtomicBool::new(false);
    let launcher = launcher(&world.state);
    let event = event(&world, SITE);
    let (outcome, ()) = tokio::join!(
        async {
            let outcome = launcher
                .rotate(&event, SITE, &world.org, Some(world.policies[0].clone()))
                .await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(&world.state, &org, &done, |_| async {}),
    );
    assert!(outcome.succeeded, "{}", outcome.detail);
    let run = the_run(&world).await;
    assert_eq!(queued(&world.state.db, &run.id).await, COMPLETE_RUN);
    assert!(run.closed_at.is_some());
    assert_eq!(run.quiescence, "quiescent");
    assert_eq!(the_job(&world).await.state, "completed");
}
