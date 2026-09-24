use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use axum::{body::Body, http::Request, Router};
use opensesame_domain::OrganizationRole;
use opensesame_storage::StoredObservationRun;
use serde_json::Value;
use tower::ServiceExt;

const ALICE: &str = "principal:00000000-0000-4000-8000-000000000011";
const BOB: &str = "principal:00000000-0000-4000-8000-000000000012";

pub(super) fn seed(id: &str, owner: &str, org: &str, state: &str) -> StoredObservationRun {
    StoredObservationRun {
        id: id.into(),
        organization_id: org.into(),
        job_id: "job:1".into(),
        target_origin: "https://example.com".into(),
        tier: "t4".into(),
        control_state: state.into(),
        quiescence: "quiescent".into(),
        handoff_queued: false,
        lease_holder: None,
        lease_expires_at: None,
        owner_principal_id: owner.into(),
        viewer_key_id: "xkey:viewer-1".into(),
        next_seq: 0,
        blocked_reason: None,
        expires_at: "2026-12-31T00:00:00+00:00".into(),
        closed_at: None,
        version: 1,
        created_at: "2026-08-31T00:00:00+00:00".into(),
        updated_at: "2026-08-31T00:00:00+00:00".into(),
    }
}

async fn send(app: &Router, headers: &HeaderMap, method: &str, uri: &str) -> (StatusCode, Value) {
    send_json(app, headers, method, uri, None).await
}

pub(super) async fn send_json(
    app: &Router,
    headers: &HeaderMap,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    *builder.headers_mut().unwrap() = headers.clone();
    let payload = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(payload).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1_048_576)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[path = "agent_runs_test_support.rs"]
mod support;
pub(super) use support::{fixture, Browser};

#[tokio::test]
async fn the_owner_reads_a_run_and_nobody_else_learns_it_exists() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();

    let (status, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["origin"], json!("https://example.com"));
    assert_eq!(view["observation_included"], json!(false));

    // Same organization, different person. 404 rather than 403: whether a
    // run exists is itself account information, and a 403 confirms it.
    let (status, _) = send(&f.app, &f.bob, "GET", "/api/v1/agent/runs/run:1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_listing_is_scoped_to_the_person_not_the_tenant() {
    let f = fixture().await;
    for (id, owner) in [("run:a", ALICE), ("run:b", BOB)] {
        f.state
            .db
            .create_observation_run(&seed(id, owner, &f.org, "agent_driving"))
            .await
            .unwrap();
    }
    let (status, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs").await;
    assert_eq!(status, StatusCode::OK);
    let runs = view["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "{view}");
    assert_eq!(runs[0]["id"], json!("run:a"));
}

#[tokio::test]
async fn a_run_row_never_carries_a_body() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();
    f.state
        .db
        .append_observation_event(&opensesame_storage::ObservationAppend {
            organization_id: &f.org,
            run_id: "run:1",
            lane: "action",
            of_step: None,
            layout_epoch: None,
            payload: b"sealed-bytes",
            recorded_at: "2026-08-31T00:00:00+00:00",
        })
        .await
        .unwrap();

    let (_, view) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs/run:1").await;
    let rendered = view.to_string();
    assert!(!rendered.contains("sealed-bytes"), "{rendered}");
    // ADR 0076 §5: a listing never reaches into the log.
    let (_, listing) = send(&f.app, &f.alice, "GET", "/api/v1/agent/runs").await;
    assert!(!listing.to_string().contains("sealed-bytes"));
}

#[tokio::test]
async fn taking_the_page_requires_the_run_to_be_parked_first() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "agent_driving"))
        .await
        .unwrap();

    // There is no path that takes the page out from under a driving agent.
    let (status, _) = f.browser.control(&f, "run:1", "take").await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Ask, and the agent parks at its next step.
    let (status, body) = f.browser.control(&f, "run:1", "handoff").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["status"], json!("accepted"));
}

#[tokio::test]
async fn one_driver_at_a_time_and_the_holder_is_recorded() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
        .await
        .unwrap();

    let (status, view) = f.browser.control(&f, "run:1", "take").await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["driver"], json!("human"));
    assert!(view["lease_expires_at"].is_string());

    // A second person in the same organization is not a second driver, and
    // is not even told the run is there.
    let (status, _) = f
        .other_browser
        .send(&f.app, "POST", "/api/v1/agent/runs/run:1/control", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn releasing_does_not_resume_autonomy() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
        .await
        .unwrap();
    f.browser.control(&f, "run:1", "take").await;

    let (status, view) = f.browser.control(&f, "run:1", "release").await;
    assert_eq!(status, StatusCode::OK, "{view}");
    // Not agent_driving: the runner re-asserts the run's preconditions
    // against the page before it drives again (ADR 0081 §6).
    assert_eq!(view["control_state"], json!("resume_requested"));
    assert_eq!(view["driver"], json!("agent"));
}

#[tokio::test]
async fn only_the_holder_may_release() {
    let f = fixture().await;
    let mut held = seed("run:1", ALICE, &f.org, "human_driving");
    held.lease_holder = Some(BOB.into());
    held.lease_expires_at = Some("2026-12-31T00:00:00+00:00".into());
    f.state.db.create_observation_run(&held).await.unwrap();

    // Alice owns the credential but Bob holds the lease: she cannot end his
    // turn, and the refusal names contention rather than ownership.
    let (status, _) = f.browser.control(&f, "run:1", "release").await;
    assert_eq!(status, StatusCode::CONFLICT);
}

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
    // Reported, not dropped: a request that vanishes teaches people to
    // press the button again.
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
    // Native fixture remains an ordinary session: no hidden assurance upgrade.
    let (status, body) = send(&f.app, &f.alice, "POST", path).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "step_up_required");
    let local = Browser::paired(&f.state, ALICE).await;
    let (status, body) = local.send(&f.app, "POST", path, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    // A genuine old passkey authentication is still too old for control.
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
