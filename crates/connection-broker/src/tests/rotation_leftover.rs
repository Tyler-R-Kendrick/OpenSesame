//! AT-ROTATION: credential rotation completes; leftover provider login stays.

use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
};
use std::sync::{Arc, Mutex as StdMutex};

struct LeftoverLogin {
    base: String,
    cookie: String,
}

async fn leftover_provider_login() -> LeftoverLogin {
    async fn session(State(live): State<Arc<StdMutex<String>>>, headers: HeaderMap) -> StatusCode {
        let want = live.lock().expect("leftover cookie").clone();
        let got = headers
            .get(axum::http::header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if got.contains(&want) {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        }
    }
    let cookie = "pre-rotation-login".to_string();
    let live = Arc::new(StdMutex::new(cookie.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("leftover login bind");
    let address = listener.local_addr().expect("leftover login address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/session", get(session))
                .with_state(live),
        )
        .await;
    });
    LeftoverLogin {
        base: format!("http://{address}"),
        cookie,
    }
}

async fn leftover_status(login: &LeftoverLogin) -> StatusCode {
    reqwest::Client::new()
        .get(format!("{}/session", login.base))
        .header(reqwest::header::COOKIE, format!("sid={}", login.cookie))
        .send()
        .await
        .expect("leftover login reachable")
        .status()
}

#[tokio::test]
async fn rotation_leaves_leftover_provider_session() {
    let leftover = leftover_provider_login().await;
    assert_eq!(
        leftover_status(&leftover).await,
        StatusCode::OK,
        "leftover provider login is live before rotation"
    );

    let fixture = rotation_fixture().await;
    let bus = opensesame_task_bus::InMemoryTaskBus::default();
    let before = fixture
        .broker
        .get_connection(&fixture.organization, &fixture.connection_id)
        .await
        .expect("connection before rotation");
    assert_eq!(before.status, ConnectionStatus::Active);

    let job = request_rotation(
        &fixture.broker,
        &bus,
        RotationTarget::Connection {
            connection_id: fixture.connection_id.clone(),
        },
        Some("proj-rot".into()),
        &fixture.organization.to_string(),
        None,
    )
    .await
    .unwrap();
    let done = execute_connection_rotation(&fixture.broker, &bus, &fixture.organization, &job.id)
        .await
        .unwrap();
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(done.status, RotationStatus::Succeeded);
    assert_ne!(
        done.status,
        RotationStatus::Failed,
        "rotation must complete, not fail closed as if it terminated sessions"
    );

    let after = fixture
        .broker
        .get_connection(&fixture.organization, &fixture.connection_id)
        .await
        .expect("connection after rotation");
    assert_eq!(
        after.status,
        ConnectionStatus::Active,
        "rotation is credential invalidation; the leftover provider login stays"
    );
    assert_ne!(after.status, ConnectionStatus::Revoked);

    assert_eq!(
        leftover_status(&leftover).await,
        StatusCode::OK,
        "a leftover provider cookie remains usable after rotation"
    );

    let view = done.public_view();
    assert_eq!(view["status"], "succeeded");
    assert_eq!(view["state"], "completed");
    assert!(view.get("session_terminated").is_none());
    assert_ne!(view["status"], "session_terminated");

    let entries = fixture
        .broker
        .list_changelog(&fixture.organization.to_string(), "proj-rot", 20, None)
        .await
        .unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry.event_type == EVENT_ROTATION_SUCCEEDED));
    for entry in &entries {
        assert_ne!(entry.event_type, "session.terminated");
        assert!(is_allowed_changelog_event_type(&entry.event_type));
    }
}
