use super::tests::{fixture, seed, send, Browser, ALICE};
use axum::http::StatusCode;
use chrono::Utc;
use opensesame_connection_broker::config_access::{role_policy, set_role_ceiling};
use serde_json::json;

use crate::session_claims::parse_principal;

#[tokio::test]
async fn a_suspended_run_is_claimed_by_a_person_never_resumed_into() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "suspended"))
        .await
        .unwrap();
    let (status, view) = f.browser.control(&f, "run:1", "take").await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["control_state"], json!("human_driving"));
}

#[tokio::test]
async fn a_handoff_inside_the_critical_section_is_queued_and_says_so() {
    let f = fixture().await;
    let mut mid_submit = seed("run:1", ALICE, &f.org, "agent_driving");
    mid_submit.quiescence = "critical".into();
    f.state
        .db
        .create_observation_run(&mid_submit)
        .await
        .unwrap();

    let (status, body) = f.browser.control(&f, "run:1", "handoff").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["status"], json!("queued"));

    let (_, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
    assert_eq!(view["control_state"], json!("agent_driving"));
    assert_eq!(view["handoff_queued"], json!(true));
}

#[tokio::test]
async fn ordinary_stale_and_non_phishing_resistant_credentials_never_take_control() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
        .await
        .unwrap();
    let path = "/api/v1/agent/runs/run:1/control";
    let (status, body) = send(&f.app, &f.alice, "POST", path).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "step_up_required");
    let local = Browser::paired(&f.state, ALICE).await;
    let (status, body) = local.send(&f.app, "POST", path, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    f.browser
        .verified_webauthn_at(&f.state, Utc::now().timestamp() - 301)
        .await;
    let (status, body) = f.browser.send(&f.app, "POST", path, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "step_up_required");
    let run = f
        .state
        .db
        .get_observation_run(&f.org, "run:1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.version, 1);
    assert_eq!(run.control_state, "awaiting_human");
    assert!(run.lease_holder.is_none());
}

#[tokio::test]
async fn fresh_browser_without_one_use_authorization_cannot_take_control() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
        .await
        .unwrap();
    let (status, body) = f
        .browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/control", None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "step_up_required");
    assert_eq!(
        f.state
            .db
            .get_observation_run(&f.org, "run:1")
            .await
            .unwrap()
            .unwrap()
            .version,
        1
    );
}

#[tokio::test]
async fn elevation_is_bound_to_run_transition_and_has_one_effect_winner() {
    let f = fixture().await;
    for id in ["run:a", "run:b"] {
        f.state
            .db
            .create_observation_run(&seed(id, ALICE, &f.org, "awaiting_human"))
            .await
            .unwrap();
    }
    let elevation = f.browser.elevation(&f.state, "run:a", "take").await;
    let wrong_transition = f.browser.elevation(&f.state, "run:a", "release").await;
    let (status, _) = f
        .browser
        .send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:a/control",
            Some(json!({"elevation":wrong_transition})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let body = Some(json!({"elevation":elevation}));
    let (status, _) = f
        .browser
        .send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:b/control",
            body.clone(),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (a, b) = tokio::join!(
        f.browser.send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:a/control",
            body.clone()
        ),
        f.browser.send(
            &f.app,
            "POST",
            "/api/v1/agent/runs/run:a/control",
            body.clone()
        )
    );
    assert_eq!(
        usize::from(a.0 == StatusCode::OK) + usize::from(b.0 == StatusCode::OK),
        1,
        "{a:?} {b:?}"
    );
    let (status, _) = f
        .browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:a/release", body)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        f.state
            .db
            .get_observation_run(&f.org, "run:a")
            .await
            .unwrap()
            .unwrap()
            .version,
        2
    );
    assert_eq!(
        f.state
            .db
            .get_observation_run(&f.org, "run:b")
            .await
            .unwrap()
            .unwrap()
            .version,
        1
    );
}

#[tokio::test]
async fn control_honors_the_role_evidence_fence() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
        .await
        .unwrap();
    let before = f
        .state
        .db
        .get_observation_run(&f.org, "run:1")
        .await
        .unwrap()
        .unwrap();

    let principal = parse_principal(ALICE).expect("alice principal");
    let auth_time = Utc::now().timestamp() - 120;
    f.browser.verified_webauthn_at(&f.state, auth_time).await;
    let policy = role_policy(
        f.state.db.pool(),
        &f.state.connection_organization,
        &principal,
    )
    .await
    .expect("role row")
    .expect("membership");
    set_role_ceiling(
        f.state.db.pool(),
        &f.state.connection_organization,
        &principal,
        None,
        policy.revision,
        Utc::now().timestamp(),
    )
    .await
    .expect("role cleared");

    let (status, _) = f.browser.control(&f, "run:1", "take").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let after = f
        .state
        .db
        .get_observation_run(&f.org, "run:1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.control_state, before.control_state);
}
