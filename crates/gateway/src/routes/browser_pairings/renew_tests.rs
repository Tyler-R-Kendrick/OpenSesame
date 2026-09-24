//! Renewing a join grant, through the real router and guard (ADR 0136 §2).

use crate::middleware::browser_user_routes::browser_join_tests::Room;
use axum::http::StatusCode;

const RENEW: &str = "/api/v1/browser-pairings/renew";
const LIST: &str = "/api/v1/shared-sessions?visibility=public";

/// Move every client's approval `seconds` into the past.
async fn approved_ago(room: &Room, seconds: i64) {
    sqlx::query("UPDATE browser_clients SET approved_at=?")
        .bind(chrono::Utc::now().timestamp() - seconds)
        .execute(room.state.db.pool())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_join_grant_renews_to_the_same_key_and_spends_the_old_token() {
    let room = Room::new().await;
    let mut who = room.browser(true).await;
    let spent = who.token.clone();
    let (status, body) = room.send(&who, "POST", RENEW, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["scope"], "host.join");
    assert_eq!(body["expires_in"], 300);
    who.token = body["access_token"].as_str().unwrap().to_owned();
    assert_ne!(who.token, spent);
    // The renewed token carries the verified join grant; the old one is gone.
    assert_eq!(room.send(&who, "GET", LIST, None).await.0, StatusCode::OK);
    who.token = spent;
    let (status, body) = room.send(&who, "GET", LIST, None).await;
    assert_eq!(
        (status, &body["error"]),
        (StatusCode::UNAUTHORIZED, &"invalid_grant".into())
    );
}

#[tokio::test]
async fn a_sitting_ends_thirty_minutes_after_the_operator_approved() {
    let room = Room::new().await;
    let mut who = room.browser(true).await;
    approved_ago(&room, 29 * 60).await;
    let (status, body) = room.send(&who, "POST", RENEW, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["expires_in"], 60, "clamped to the sitting");
    who.token = body["access_token"].as_str().unwrap().to_owned();

    approved_ago(&room, 30 * 60).await;
    let (status, body) = room.send(&who, "POST", RENEW, None).await;
    assert_eq!(
        (status, &body["error"]),
        (StatusCode::FORBIDDEN, &"join_sitting_over".into())
    );
    // Refused without spending: the token in hand works until it lapses.
    assert_eq!(room.send(&who, "GET", LIST, None).await.0, StatusCode::OK);
}

#[tokio::test]
async fn only_a_join_grant_renews() {
    let room = Room::new().await;
    let who = room.browser(true).await;
    sqlx::query("UPDATE browser_clients SET capabilities_json='[\"host.sync.read\"]'")
        .execute(room.state.db.pool())
        .await
        .unwrap();
    let (status, body) = room.send(&who, "POST", RENEW, None).await;
    assert_eq!(
        (status, &body["error"]),
        (StatusCode::UNAUTHORIZED, &"capability_denied".into())
    );
}
