//! A rung whose target another runner holds rotated nothing, so it publishes
//! no outcome — above all not "renewed", which would resolve the expiry alert
//! and spend the rung for a rotation that never happened — and it gives the
//! policy lease back so the policy is retried instead of lapsing.

use chrono::Utc;
use opensesame_connection_broker::rotation::web_login::{
    request_claimed_web_login_rotation, WebLoginClaim,
};
use opensesame_lifecycle::{EVENT_RENEWAL_DUE, EVENT_RENEWAL_FAILED, EVENT_RENEWAL_SUCCEEDED};

use super::test_support::*;
use crate::lifecycle::dispatch;

/// The policy's lease column and its consecutive-failure count.
async fn lease_and_attempts(world: &World) -> (Option<String>, i64) {
    sqlx::query_as("SELECT lease_until, attempts FROM rotation_policies WHERE id = ?")
        .bind(&world.policies[0].id)
        .fetch_one(world.state.db.pool())
        .await
        .unwrap()
}

#[tokio::test]
async fn a_rung_for_a_target_another_replica_holds_publishes_no_outcome() {
    let world = world(&[SITE], ALLOW_ALL).await;
    // A runner on another replica holds SITE; its claim is in the shared
    // database and its registry is not this process's.
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

    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    world.state.web_login_runs.idle().await;

    assert_eq!(world.published(EVENT_RENEWAL_DUE).await.len(), 1);
    assert!(
        world.published(EVENT_RENEWAL_SUCCEEDED).await.is_empty(),
        "nothing rotated, so nothing is renewed"
    );
    assert!(
        world.published(EVENT_RENEWAL_FAILED).await.is_empty(),
        "the holder may yet rotate it, so nothing failed either"
    );
    let (lease, attempts) = lease_and_attempts(&world).await;
    assert_eq!(
        lease, None,
        "the policy lease is released, not left to lapse"
    );
    assert_eq!(attempts, 1, "and the policy backs off to be retried");
    let policy = &world
        .state
        .connection_broker
        .list_rotation_policies(&world.org_text())
        .await
        .unwrap()[0];
    assert!(policy.next_attempt_at.is_some());
    assert!(!policy.needs_attention);
}

#[tokio::test]
async fn a_second_rung_in_this_process_publishes_no_outcome_either() {
    let world = world(&[SITE], ALLOW_ALL).await;
    let first = super::start(&world.state, &event(&world, SITE)).await;
    assert!(first.pending && first.succeeded, "{}", first.detail);

    // The same target is already queued here: the second rung is dispatched
    // as a skipped one, and the dispatcher publishes nothing for it.
    dispatch::publish(&world.state, &event(&world, SITE), Utc::now()).await;
    assert!(world.published(EVENT_RENEWAL_SUCCEEDED).await.is_empty());
    assert!(world.published(EVENT_RENEWAL_FAILED).await.is_empty());

    world.state.web_login_runs.abort_all();
    world.state.web_login_runs.idle().await;
}
