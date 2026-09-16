//! Rate limits and upstream errors, over the real protocol.
//!
//! Discord rate-limits aggressively on role and member routes, so this is not an
//! edge case — it is the normal path under any load. The interesting assertions
//! are about *what is retried*: a `429` was rejected before it was handled, so
//! re-sending it cannot double-apply, while a `5xx` may have been applied and the
//! answer lost.

mod support;

use opensesame_collab_adapter::{plan_apply, ExecutionError, Verb};
use serde_json::json;
use support::scenario::{now, owned_role_name, projection, Scenario};
use support::{GuildState, Scripted};

/// A 429 on the create is retried, with the float wait from the body, and the
/// role is created exactly once.
///
/// The wait comes from `retry_after` in the JSON body rather than the integer
/// `Retry-After` header: Discord answers sub-second waits like `0.25`, which an
/// integer header rounds to `0` and turns into a hot retry loop.
#[tokio::test]
async fn a_rate_limited_create_is_retried_once_and_creates_one_role() {
    let scene = Scenario::start(GuildState::new()).await;
    // Observe before scripting: the list and create share a `/roles` suffix, and
    // a script registered first would be consumed by the observation GET.
    let observed = scene.observe().await;
    scene
        .fixture
        .script(Scripted::rate_limit("POST", "/roles", 1));

    let plan = plan_apply(
        &scene.registration,
        &projection(&[Verb::ChannelRead]),
        &observed,
        now(),
    )
    .unwrap();
    let outcome = scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .expect("a 429 is not a failure");

    assert_eq!(outcome.rate_limit_retries, 1);
    assert_eq!(
        scene.backoff.waits(),
        vec![0.25],
        "the float from the 429 body, not a rounded header"
    );

    let names = scene.fixture.state.lock().unwrap().role_names();
    assert_eq!(
        names
            .iter()
            .filter(|name| *name == &owned_role_name())
            .count(),
        1,
        "a retried 429 must not produce a duplicate role"
    );
}

/// Still rate limited after the retry budget: reported, not retried forever.
#[tokio::test]
async fn an_unrelenting_rate_limit_is_surfaced() {
    let scene = Scenario::start(GuildState::new()).await;
    let observed = scene.observe().await;
    scene
        .fixture
        .script(Scripted::rate_limit("POST", "/roles", 99));

    let plan = plan_apply(
        &scene.registration,
        &projection(&[Verb::ChannelRead]),
        &observed,
        now(),
    )
    .unwrap();
    let error = scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap_err();

    match error {
        ExecutionError::RateLimited { step, attempts } => {
            assert_eq!(step, "create_role");
            assert_eq!(attempts, 4, "one attempt plus MAX_RATE_LIMIT_RETRIES");
        }
        other => panic!("expected RateLimited, got {other}"),
    }
}

/// A 500 is not retried, because the request may have been applied.
///
/// Retrying a `POST /guilds/{id}/roles` whose answer was lost is how a guild
/// slowly fills with duplicate roles, and a guild caps at 250.
#[tokio::test]
async fn a_server_error_is_not_retried() {
    let scene = Scenario::start(GuildState::new()).await;
    let observed = scene.observe().await;
    scene.fixture.script(Scripted {
        method: "POST".to_owned(),
        path_suffix: "/roles".to_owned(),
        status: 500,
        body: json!({ "message": "Internal Server Error", "code": 0 }).to_string(),
        remaining: 5,
    });

    let plan = plan_apply(
        &scene.registration,
        &projection(&[Verb::ChannelRead]),
        &observed,
        now(),
    )
    .unwrap();
    let error = scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap_err();

    assert!(matches!(error, ExecutionError::Api { status: 500, .. }));
    assert!(
        scene.backoff.waits().is_empty(),
        "no backoff, because there was no retry"
    );
    assert_eq!(
        scene
            .fixture
            .mutations()
            .iter()
            .filter(|hit| hit.starts_with("POST"))
            .count(),
        1,
        "exactly one attempt at a non-idempotent create"
    );
}

/// Execution stops at the first failure rather than running the steps the failed
/// one was supposed to bound.
///
/// The plan's order is a safety property: continuing past a failed overwrite
/// would assign a role whose channel scope was never written.
#[tokio::test]
async fn a_failed_overwrite_stops_the_plan_before_the_assignment() {
    let scene = Scenario::start(GuildState::new()).await;
    scene.fixture.script(Scripted::missing_permissions(
        "PUT",
        "/permissions/720000000000000100",
    ));

    let plan = plan_apply(
        &scene.registration,
        &projection(&[Verb::ChannelRead]),
        &scene.observe().await,
        now(),
    )
    .unwrap();
    let error = scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap_err();

    match error {
        ExecutionError::Api { step, code, .. } => {
            assert_eq!(step, "set_channel_overwrite");
            assert_eq!(code, 50_013);
        }
        other => panic!("expected an Api error, got {other}"),
    }

    let state = scene.fixture.state.lock().unwrap();
    assert_eq!(
        state.member_role_ids(support::SUBJECT_ID).len(),
        2,
        "the subject must not have been assigned an unbounded role"
    );
}

/// One observation reads roles, members, and each in-scope channel. The fixture
/// 404s anything else, so a wrong endpoint is a failure rather than a silence.
#[tokio::test]
async fn one_observation_reads_exactly_the_documented_routes() {
    let scene = Scenario::start(GuildState::new()).await;
    let observed = scene.observe().await;
    assert_eq!(observed.bot_highest_position, support::BOT_ROLE_POSITION);
    assert_eq!(
        scene.fixture.paths(),
        vec![
            "GET /api/v10/users/@me".to_owned(),
            format!("GET /api/v10/guilds/{}/roles", support::GUILD_ID),
            format!(
                "GET /api/v10/guilds/{}/members/{}",
                support::GUILD_ID,
                support::BOT_USER_ID
            ),
            format!(
                "GET /api/v10/guilds/{}/members/{}",
                support::GUILD_ID,
                support::SUBJECT_ID
            ),
            format!("GET /api/v10/channels/{}", support::CHANNEL_ID),
        ],
        "who the bot is, the roles, the bot's roles, the subject's, each channel"
    );
}
