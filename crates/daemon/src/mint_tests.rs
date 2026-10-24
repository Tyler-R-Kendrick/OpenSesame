//! `POST /v1/mint` tests, beside `mint.rs` so the route stays inside its size
//! budget (ADR 0093).

use super::*;
use crate::{router, tests::test_state};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use axum::routing::post;
use axum::Router;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn request(body: &str, with_token: bool) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/v1/mint")
        .header("content-type", "application/json");
    if with_token {
        builder = builder.header("x-opensesame-operator", crate::test_operator_token());
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

/// A stub gateway mint endpoint recording the forwarded body.
async fn spawn_gateway(status: StatusCode, body: Value) -> (String, Arc<Mutex<Vec<Value>>>) {
    #[derive(Clone)]
    struct Stub {
        calls: Arc<Mutex<Vec<Value>>>,
        status: StatusCode,
        body: Value,
    }
    let calls = Arc::new(Mutex::new(Vec::new()));
    let stub = Stub {
        calls: calls.clone(),
        status,
        body,
    };
    let app = Router::new()
        .route(
            "/api/v1/connections/{id}/mint",
            post(
                |State(stub): State<Stub>, Json(body): Json<Value>| async move {
                    stub.calls.lock().unwrap().push(body);
                    (stub.status, Json(stub.body.clone()))
                },
            ),
        )
        .with_state(stub);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://127.0.0.1:{}", addr.port()), calls)
}

#[tokio::test]
async fn unauthenticated_callers_are_refused() {
    let app = router(test_state("http://127.0.0.1:1"));
    let res = app
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, false))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unsafe_connection_ids_never_reach_the_gateway() {
    for id in ["../admin", "a b", "x/../y", "short"] {
        // Fresh state per id: the rate bucket is per-caller, not per-id.
        let app = router(test_state("http://127.0.0.1:1"));
        let body = format!(r#"{{"connection_id":"{id}"}}"#);
        let res = app.oneshot(request(&body, true)).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{id}");
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"], "invalid_connection_id");
    }
}

#[tokio::test]
async fn mint_is_rate_limited_on_its_own_bucket() {
    let app = router(test_state("http://127.0.0.1:1"));
    let first = app
        .clone()
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
        .await
        .unwrap();
    // Auth and budget pass; the unreachable gateway answers 502.
    assert_eq!(first.status(), StatusCode::BAD_GATEWAY);
    let second = app
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_successful_mint_passes_the_gateway_answer_through() {
    let derived = json!({
        "connection_id": "conn_stub",
        "provider_id": "github",
        "kind": "github_app_installation",
        "derived_token": "ghs_derived-token",
        "expires_at": "2026-08-20T03:00:00Z",
        "subject": "user:alice",
        "actor": "operator",
        "issued_at": "2026-08-20T02:00:00Z",
    });
    let (gateway, calls) = spawn_gateway(StatusCode::OK, derived).await;
    let app = router(test_state(&gateway));
    let res = app
        .oneshot(request(
            r#"{"connection_id":"conn_stub","installation_id":"12345678"}"#,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = to_bytes(res.into_body(), 8192).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["derived_token"], "ghs_derived-token");
    assert_eq!(json["kind"], "github_app_installation");
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["installation_id"], "12345678");
}

#[tokio::test]
async fn unmintable_is_a_passthrough_not_a_rewrite() {
    let (gateway, _) = spawn_gateway(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({"error": "unmintable"}),
    )
    .await;
    let app = router(test_state(&gateway));
    let res = app
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["error"], "unmintable");
}

#[tokio::test]
async fn a_partitioned_gateway_is_502() {
    let app = router(test_state("http://127.0.0.1:1"));
    let res = app
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["error"], "host_api_unreachable");
}

#[path = "mint_peer_tests.rs"]
mod peer;

/// Hard per-case deadline: a regression that hangs fails fast instead of
/// wedging the suite.
const CHAOS_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

#[tokio::test]
async fn chaos_reset_gateway_is_502_without_credential_material() {
    use crate::tests::fault::{Fault, FaultListener};
    tokio::time::timeout(CHAOS_DEADLINE, async {
        let gateway = FaultListener::spawn(Fault::Reset).await;
        let app = router(test_state(gateway.url()));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["error"], "host_api_unreachable");
        assert!(gateway.connections() >= 1, "the gateway was never dialed");
        // The operator token forwarded toward the gateway never echoes
        // back, and no mint-shaped material is invented on failure.
        assert!(!text.contains(crate::test_operator_token()), "{text}");
        assert!(!text.contains("derived_token"), "{text}");
    })
    .await
    .expect("chaos case exceeded its deadline");
}

#[tokio::test]
async fn chaos_stalled_gateway_is_502_within_the_client_timeout() {
    use crate::tests::fault::{Fault, FaultListener};
    tokio::time::timeout(CHAOS_DEADLINE, async {
        let gateway = FaultListener::spawn(Fault::Stall).await;
        let app = router(test_state(gateway.url()));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        // The reqwest timeout (400 ms in test state) fires long before
        // the deadline; the caller gets a failure, never a hang.
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["error"], "host_api_unreachable");
        assert!(gateway.connections() >= 1, "the gateway was never dialed");
        assert!(!text.contains(crate::test_operator_token()), "{text}");
        assert!(!text.contains("derived_token"), "{text}");
    })
    .await
    .expect("chaos case exceeded its deadline");
}

#[cfg(test)]
mod characterization {
    use super::*;

    /// Snapshots of the `/v1/mint` wire shapes: the passthrough success
    /// and the two failure classes the daemon itself authors.
    ///
    /// These do not assert the shapes are *right* — the tests above do
    /// that. They pin what the route actually serializes, so a new field
    /// has to be looked at and accepted rather than shipped unnoticed. On
    /// this route that matters more than most: the success body is the one
    /// daemon surface that carries credential material (`derived_token`,
    /// ADR 0049 §6), so the pin redacts it — and the gateway-clock
    /// timestamps — and keeps only the shape. A new key here is a
    /// disclosure decision; read the diff.
    #[tokio::test]
    async fn mint_success_wire_shape_is_pinned() {
        let derived = json!({
            "connection_id": "conn_stub",
            "provider_id": "github",
            "kind": "github_app_installation",
            "derived_token": "ghs_PLANTED-DERIVED-VALUE-MUST-BE-REDACTED",
            "expires_at": "2026-08-20T03:00:00Z",
            "subject": "user:alice",
            "actor": "operator",
            "issued_at": "2026-08-20T02:00:00Z",
        });
        let (gateway, _calls) = spawn_gateway(StatusCode::OK, derived).await;
        let app = router(test_state(&gateway));
        let res = app
            .oneshot(request(
                r#"{"connection_id":"conn_stub","installation_id":"12345678"}"#,
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 8192).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        // The derived token is credential material and the stamps are the
        // gateway's clock: pin the shape, never the values (I1).
        insta::assert_json_snapshot!(body, {
            ".derived_token" => "[derived]",
            ".expires_at" => "[expiry]",
            ".issued_at" => "[issued]",
        });
    }

    #[tokio::test]
    async fn gateway_unreachable_wire_shape_is_pinned() {
        let app = router(test_state("http://127.0.0.1:1"));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        insta::assert_json_snapshot!(body);
    }

    /// The gateway's `materialization_denied` answer (403 from
    /// `broker_error` on `BrokerError::MaterializationDenied`) passes
    /// through untouched — the daemon authors nothing here.
    #[tokio::test]
    async fn materialization_denied_wire_shape_is_pinned() {
        let (gateway, _calls) = spawn_gateway(
            StatusCode::FORBIDDEN,
            json!({
                "error": "materialization_denied",
                "hint": "connection policy denies materialization",
            }),
        )
        .await;
        let app = router(test_state(&gateway));
        let res = app
            .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        insta::assert_json_snapshot!(body);
    }
}
