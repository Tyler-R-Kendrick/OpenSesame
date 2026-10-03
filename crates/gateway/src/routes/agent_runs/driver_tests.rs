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
    claimed_request(f, r#"{"step":"read_dom_redacted","strip":[]}"#).await;
}

async fn claimed_request(f: &Fixture, request: &str) {
    f.state
        .db
        .create_observation_run(&seed(RUN, ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    f.state
        .db
        .enqueue_runner_step(&f.org, RUN, 0, request, "2026-08-31T00:00:00+00:00")
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

/// Nothing was stored, and the driver may still answer correctly.
async fn assert_still_claimed(f: &Fixture) {
    assert!(stored(f).await.is_none(), "nothing was stored");
    let step = f
        .state
        .db
        .get_runner_step(&f.org, RUN, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step.state, "claimed");
}

#[tokio::test]
async fn a_field_the_outcome_does_not_have_is_refused_and_never_stored() {
    let f = fixture().await;
    claimed_request(&f, r#"{"step":"navigate","url":"https://example.com"}"#).await;
    for outcome in [
        json!({"outcome": "done", "password": "hunter2"}),
        json!({"outcome": "failed", "error": "timeout", "detail": "x"}),
    ] {
        let (status, body) = settle(&f, outcome).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"], json!("invalid_outcome"));
        assert!(!body.to_string().contains("hunter2"), "nothing is echoed");
        assert_still_claimed(&f).await;
    }
    let (status, body) = settle(&f, json!({"outcome": "done"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(stored(&f).await.as_deref(), Some(r#"{"outcome":"done"}"#));
}

#[tokio::test]
async fn an_outcome_that_does_not_answer_the_step_is_refused() {
    let f = fixture().await;
    claimed_request(&f, r#"{"step":"navigate","url":"https://example.com"}"#).await;
    let (status, body) = settle(&f, json!({"outcome": "dom", "text": "t", "epoch": 1})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], json!("wrong_outcome"));
    assert_still_claimed(&f).await;

    let (status, body) = settle(&f, json!("done")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_still_claimed(&f).await;
}

#[tokio::test]
async fn a_custody_step_takes_only_a_custody_outcome() {
    let f = fixture().await;
    claimed_request(&f, r#"{"step":"seal_candidate","handle":"candidate:1"}"#).await;
    let (status, body) = settle(
        &f,
        json!({"outcome": "sealed", "backed_up": true, "candidate": "hunter2"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], json!("invalid_outcome"));
    let (status, body) = settle(&f, json!({"outcome": "done"})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], json!("wrong_outcome"));
    assert_still_claimed(&f).await;

    let (status, body) = settle(&f, json!({"outcome": "sealed", "backed_up": true})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        stored(&f).await.as_deref(),
        Some(r#"{"backed_up":true,"outcome":"sealed"}"#),
        "stored as the typed outcome encodes, not as the driver ordered it"
    );
}

#[tokio::test]
async fn a_claim_that_ran_out_cannot_settle_before_anyone_reclaims_it() {
    let f = fixture().await;
    claimed_step(&f).await;
    // The lease ended a minute ago; nobody has taken the step since.
    sqlx::query("UPDATE runner_steps SET claim_expires_at = ? WHERE run_id = ?")
        .bind((chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339())
        .bind(RUN)
        .execute(f.state.db.pool())
        .await
        .unwrap();
    let (status, body) = settle(&f, json!({"outcome": "dom", "text": "late", "epoch": 1})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], json!("not_the_claimant"));
    assert_still_claimed(&f).await;

    // Claiming again renews it, and then the same driver settles.
    let (status, _) = f
        .browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/steps/claim", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = settle(&f, json!({"outcome": "dom", "text": "ok", "epoch": 1})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
