//! The step channel through the routes: claim, settle, and what a settled
//! outcome is allowed to hold.

use super::super::tests::{fixture, seed, Fixture};
use axum::http::StatusCode;
use serde_json::json;

const ALICE: &str = "principal:00000000-0000-4000-8000-000000000011";

#[tokio::test]
async fn a_driver_claims_a_step_then_settles_it() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    f.state
        .db
        .enqueue_runner_step(
            &f.org,
            "run:1",
            0,
            r#"{"step":"navigate","url":"https://example.com"}"#,
            "2026-08-31T00:00:00+00:00",
        )
        .await
        .unwrap();

    let (status, claimed) = f
        .browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["seq"], json!(0));
    assert_eq!(claimed["request"]["step"], json!("navigate"));
    assert_eq!(claimed["secrets_returned"], json!(false));

    let (status, settled) = f
        .browser
        .send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:1/steps/0/outcome",
            Some(json!({"outcome": {"outcome": "done"}})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{settled}");
    assert_eq!(settled["status"], json!("settled"));
}

#[tokio::test]
async fn nothing_to_do_answers_cheaply() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    let (status, _) = f
        .browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn somebody_elses_run_is_not_drivable_and_does_not_admit_it_exists() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    f.state
        .db
        .enqueue_runner_step(
            &f.org,
            "run:1",
            0,
            r#"{"step":"navigate","url":"https://example.com"}"#,
            "2026-08-31T00:00:00+00:00",
        )
        .await
        .unwrap();

    let (status, _) = f
        .other_browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_step_nobody_claimed_cannot_be_settled() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    f.state
        .db
        .enqueue_runner_step(
            &f.org,
            "run:1",
            0,
            r##"{"step":"submit","selector":"#save"}"##,
            "2026-08-31T00:00:00+00:00",
        )
        .await
        .unwrap();

    let (status, body) = f
        .browser
        .send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:1/steps/0/outcome",
            Some(json!({"outcome": {"outcome": "done"}})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], json!("not_the_claimant"));
}

const RUN: &str = "run:1";

/// A run with one step enqueued and claimed by Alice's browser.
async fn claimed_step(f: &Fixture) {
    f.state
        .db
        .create_observation_run(&seed(RUN, ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    f.state
        .db
        .enqueue_runner_step(
            &f.org,
            RUN,
            0,
            r#"{"step":"read_dom_redacted","strip":[]}"#,
            "2026-08-31T00:00:00+00:00",
        )
        .await
        .unwrap();
    let (status, _) = f
        .browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
        .await;
    assert_eq!(status, StatusCode::OK);
}

async fn settle(f: &Fixture, outcome: serde_json::Value) -> (StatusCode, serde_json::Value) {
    f.browser
        .send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:1/steps/0/outcome",
            Some(json!({ "outcome": outcome })),
        )
        .await
}

async fn stored(f: &Fixture) -> Option<String> {
    f.state
        .db
        .get_runner_step(&f.org, RUN, 0)
        .await
        .unwrap()
        .unwrap()
        .outcome_json
}

#[tokio::test]
async fn a_credential_shaped_string_is_stored_as_its_marker() {
    let f = fixture().await;
    claimed_step(&f).await;
    let secret = format!("ghp_{}", "x".repeat(36));
    let (status, body) = settle(
        &f,
        json!({"outcome": "dom", "text": format!("token {secret} here"), "epoch": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("settled"));
    assert_eq!(body["redacted"], json!(true));

    let row = stored(&f).await.unwrap();
    assert!(!row.contains(&secret), "{row}");
    let outcome: serde_json::Value = serde_json::from_str(&row).unwrap();
    assert_eq!(
        outcome,
        json!({"outcome": "dom", "text": "token [redacted:github_token] here", "epoch": 7})
    );
}

#[tokio::test]
async fn a_clean_outcome_is_stored_as_the_driver_sent_it() {
    let f = fixture().await;
    claimed_step(&f).await;
    let (status, body) = settle(&f, json!({"outcome": "dom", "text": "hello", "epoch": 1})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["redacted"], json!(false));
    let row: serde_json::Value = serde_json::from_str(&stored(&f).await.unwrap()).unwrap();
    assert_eq!(row, json!({"outcome": "dom", "text": "hello", "epoch": 1}));
}

#[tokio::test]
async fn an_oversized_outcome_is_refused_and_the_claim_stands() {
    let f = fixture().await;
    claimed_step(&f).await;
    let big = "a".repeat(super::super::scrub::MAX_OUTCOME_BYTES + 1);
    let (status, body) = settle(&f, json!({"outcome": "dom", "text": big, "epoch": 1})).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(body["error"], json!("outcome_too_large"));
    assert!(stored(&f).await.is_none(), "nothing was stored");
    let step = f
        .state
        .db
        .get_runner_step(&f.org, RUN, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step.state, "claimed", "the driver may still answer");

    // Just inside the bound is accepted.
    let ok = "a".repeat(super::super::scrub::MAX_OUTCOME_BYTES / 2);
    let (status, _) = settle(&f, json!({"outcome": "dom", "text": ok, "epoch": 1})).await;
    assert_eq!(status, StatusCode::OK);
}
