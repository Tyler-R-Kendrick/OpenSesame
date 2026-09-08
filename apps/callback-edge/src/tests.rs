use super::*;
use axum::{body::Body, http::Request};
use tower::ServiceExt;

fn master() -> [u8; 32] {
    let mut result = [0; 32];
    result[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    result[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    result
}

fn now() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    )
    .unwrap()
}

#[test]
fn signatures_bind_every_destination_component() {
    let key = master();
    let path = "/webhooks/conn_1/provider";
    let time = now();
    let headers = signature::sign(&key, path, time, "delivery_1", b"{}");
    assert!(signature::verify(
        &key,
        &Method::POST,
        &path.parse().unwrap(),
        &headers,
        b"{}",
        time
    )
    .is_some());
    for target in [
        "/webhooks/conn_2/provider",
        "/webhooks/conn_1/other",
        "/webhooks/conn_1/%70rovider",
        "/webhooks/conn_1/../provider",
        "/webhooks/conn_1//provider",
        "/webhooks/conn_1/provider?route=other",
    ] {
        assert!(signature::verify(
            &key,
            &Method::POST,
            &target.parse().unwrap(),
            &headers,
            b"{}",
            time
        )
        .is_none());
    }
    assert!(signature::verify(
        &key,
        &Method::GET,
        &path.parse().unwrap(),
        &headers,
        b"{}",
        time
    )
    .is_none());
    assert!(signature::verify(
        &key,
        &Method::POST,
        &path.parse().unwrap(),
        &headers,
        b"changed",
        time
    )
    .is_none());
    assert!(signature::verify(
        &key,
        &Method::POST,
        &path.parse().unwrap(),
        &headers,
        b"{}",
        time + 301
    )
    .is_none());
    assert_header_binding(&key, path, &headers, time);
    assert!(signature::verify(
        &master(),
        &Method::POST,
        &path.parse().unwrap(),
        &headers,
        b"{}",
        time
    )
    .is_none());
    assert!(signature::verify(
        &key,
        &Method::POST,
        &path.parse().unwrap(),
        &HeaderMap::new(),
        b"{}",
        time
    )
    .is_none());
    assert!(signature::verify(
        &key,
        &Method::POST,
        &path.parse().unwrap(),
        &headers,
        b"{}",
        time - 301
    )
    .is_none());
}

fn assert_header_binding(key: &[u8; 32], path: &str, headers: &HeaderMap, time: i64) {
    let mut duplicate = headers.clone();
    duplicate.append("x-opensesame-timestamp", time.to_string().parse().unwrap());
    assert!(signature::verify(
        key,
        &Method::POST,
        &path.parse().unwrap(),
        &duplicate,
        b"{}",
        time
    )
    .is_none());
    let mut swapped = headers.clone();
    swapped.insert("x-opensesame-delivery-id", "delivery_2".parse().unwrap());
    assert!(signature::verify(
        key,
        &Method::POST,
        &path.parse().unwrap(),
        &swapped,
        b"{}",
        time
    )
    .is_none());
}

async fn state(key: [u8; 32]) -> Arc<EdgeState> {
    let db = Db::connect_memory().await.unwrap();
    db.migrate().await.unwrap();
    Arc::new(EdgeState {
        master: Zeroizing::new(key),
        db,
        routes: ["conn_1/provider".into()].into(),
    })
}

fn request(key: &[u8; 32], path: &str, delivery: &str, body: &'static [u8]) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .body(Body::from(body))
        .unwrap();
    *request.headers_mut() = signature::sign(key, path, now(), delivery, body);
    request
}

#[tokio::test]
async fn real_requests_deduplicate_and_hide_route_mismatches() {
    let key = master();
    let app = router(state(key).await);
    let path = "/webhooks/conn_1/provider";
    let (first, second) = tokio::join!(
        app.clone().oneshot(request(&key, path, "d1", b"{}")),
        app.clone().oneshot(request(&key, path, "d1", b"{}"))
    );
    assert_eq!(first.unwrap().status(), StatusCode::OK);
    assert_eq!(second.unwrap().status(), StatusCode::OK);
    assert_eq!(
        app.clone()
            .oneshot(request(&key, path, "d1", b"changed"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(request(&key, "/webhooks/unknown/provider", "d2", b"{}"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let oversized = vec![b'x'; signature::MAX_BODY + 1];
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .body(Body::from(oversized))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
