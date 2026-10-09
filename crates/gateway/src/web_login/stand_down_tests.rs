//! Why a run's `agent_shutdown` says what it says, through the real launcher.
//!
//! A run that stopped because a person asked for the page, or already holds
//! it, did not fail: its shutdown reason is `cancelled`. That reading is the
//! launcher's stand-down probe over the run's step channel
//! (`Harness::open`), and these tests drive the whole launcher — the real
//! step queue and the persisted control state — and read the reason from the
//! context the session actually emitted. An ordinary failure still says
//! `error`, and a run that completes says `completed`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use opensesame_storage::Db;
use serde_json::Value;

use super::test_support::*;
use crate::lifecycle::responders::Outcome;

const DENY_ALL: &str = r#"{"version":1,"unlisted_tools":"deny"}"#;

/// Rotate against a driver that runs `on_claim` for each claimed step, and
/// return the outcome and every shutdown reason the run's session emitted.
async fn rotate_driven<F, Fut>(world: &World, on_claim: F) -> (Outcome, Vec<String>)
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let org = world.org_text();
    let done = AtomicBool::new(false);
    let tap = Tap::default();
    let launcher = launcher(&world.state).with_tap(tap.clone());
    let event = event(world, SITE);
    let (outcome, ()) = tokio::join!(
        async {
            let outcome = launcher
                .rotate(&event, SITE, &world.org, Some(world.policies[0].clone()))
                .await;
            done.store(true, Ordering::SeqCst);
            outcome
        },
        drive(&world.state, &org, &done, on_claim),
    );
    (outcome, tap.shutdown_reasons())
}

/// Whether `request` is the first `fill_credential` the driver claims.
fn first_fill(request: &Value, seen: &AtomicUsize) -> bool {
    request["step"] == "fill_credential" && seen.fetch_add(1, Ordering::SeqCst) == 0
}

/// What `POST .../handoff` does, when `asked`.
async fn ask_for_the_page(db: Db, org: String, asked: bool) {
    if asked {
        let run = the_open_run(&db, &org).await;
        assert!(request_handoff(&db, &org, &run.id).await.is_some());
    }
}

/// The person takes the page between steps, when `taken`.
async fn take_the_page(db: Db, taken: bool) {
    if taken {
        sqlx::query(
            "UPDATE observation_runs SET control_state = 'human_driving', \
             lease_holder = ?, lease_expires_at = '2999-01-01T00:00:00+00:00'",
        )
        .bind(OWNER)
        .execute(db.pool())
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn a_run_handed_to_a_person_shuts_down_cancelled() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let org = world.org_text();
    let seen = AtomicUsize::new(0);
    let (outcome, reasons) = rotate_driven(&world, |request| {
        let asked = first_fill(&request, &seen);
        ask_for_the_page(world.state.db.clone(), org.clone(), asked)
    })
    .await;
    assert!(!outcome.succeeded, "{}", outcome.detail);
    assert_eq!(reasons, ["cancelled"]);
}

#[tokio::test]
async fn a_run_whose_page_a_person_already_holds_shuts_down_cancelled() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let seen = AtomicUsize::new(0);
    let (outcome, reasons) = rotate_driven(&world, |request| {
        take_the_page(world.state.db.clone(), first_fill(&request, &seen))
    })
    .await;
    assert!(!outcome.succeeded, "{}", outcome.detail);
    assert_eq!(reasons, ["cancelled"]);
}

#[tokio::test]
async fn an_ordinary_failure_shuts_down_with_an_error() {
    // The organization's hooks refuse every tool: the run blocks on its own,
    // and nobody stood down for anyone.
    let world = world(&[SITE], DENY_ALL).await;
    let (outcome, reasons) = rotate_driven(&world, |_| async {}).await;
    assert!(!outcome.succeeded, "{}", outcome.detail);
    assert_eq!(reasons, ["error"]);
}

#[tokio::test]
async fn a_run_that_completes_shuts_down_completed() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let (outcome, reasons) = rotate_driven(&world, |_| async {}).await;
    assert!(outcome.succeeded, "{}", outcome.detail);
    assert_eq!(reasons, ["completed"]);
}
