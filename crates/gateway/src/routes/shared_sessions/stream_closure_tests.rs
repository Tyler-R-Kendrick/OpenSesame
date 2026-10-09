//! A previously opened HTTP SSE stream must lose a withdrawn seat immediately.
use super::{actor, call, next_event, next_event_of, open_session, open_stream, state, Actor};
use axum::{body::BodyDataStream, http::StatusCode, Router};
use futures::StreamExt;
use opensesame_domain::{OrganizationId, PrincipalId};
use serde_json::{json, Value};
use std::time::Duration;

async fn seat(router: &Router, id: &str, operator: &Actor, principal: PrincipalId, mode: &str) {
    let (status, body) = call(
        router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/members"),
        operator,
        json!({"principal_id": principal.to_string(), "mode": mode}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
async fn subscribe(router: &Router, id: &str, reader: &Actor) -> BodyDataStream {
    let mut stream = open_stream(
        router,
        &format!("/api/v1/shared-sessions/{id}/events"),
        reader,
    )
    .await;
    next_event(&mut stream, Duration::from_secs(5))
        .await
        .expect("initial presence event");
    stream
}
async fn ended(stream: &mut BodyDataStream) {
    let frame = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("a withdrawn stream must end without waiting for reconnect or heartbeat");
    assert!(
        frame.is_none(),
        "withdrawn stream retained live session delivery: {frame:?}"
    );
}

#[tokio::test]
async fn closing_terminates_existing_observer_stream_but_preserves_operator_record() {
    let st = state().await;
    let org = OrganizationId::new();
    let router = crate::routes::router(st.clone());
    let operator = actor(&st, org);
    let observer = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    seat(&router, &id, &operator, observer.principal, "observer").await;
    let mut observer_stream = subscribe(&router, &id, &observer).await;
    let mut operator_stream = subscribe(&router, &id, &operator).await;
    // Discard the operator's presence frame queued for the observer.
    next_event(&mut observer_stream, Duration::from_secs(5))
        .await
        .expect("operator presence");
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/close"),
        &operator,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    ended(&mut observer_stream).await;
    let event = next_event_of(
        &mut operator_stream,
        "session_closed",
        Duration::from_secs(5),
    )
    .await
    .expect("operator retains the closed-session record");
    assert!(event["closed_at"].is_string(), "{event}");
    let (_, detail) =
        super::get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert!(detail["closed_at"].is_string());
}

#[tokio::test]
async fn removing_a_seat_terminates_its_existing_stream_without_closing_the_session() {
    let st = state().await;
    let router = crate::routes::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let observer = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    seat(&router, &id, &operator, observer.principal, "observer").await;
    let mut stream = subscribe(&router, &id, &observer).await;
    seat(&router, &id, &operator, observer.principal, "none").await;
    ended(&mut stream).await;
    let (status, detail) =
        super::get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["closed_at"], Value::Null);
}
