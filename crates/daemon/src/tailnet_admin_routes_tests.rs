//! What the spec's exchanges do not cover: CORS, the pairing exchange, the
//! OAuth access token, budgets, and a daemon with nowhere to keep state.

use super::conformance::{connected, stub_upstream, ORIGIN};
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use opensesame_tailnet_admin::{Credential, CredentialKind};
use secrecy::SecretString;
use serde_json::json;
use tower::ServiceExt;

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn get(path: &str, origin: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::get(path).header(header::ORIGIN, origin);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::empty()).unwrap()
}

fn post(path: &str, token: &str, body: &Value) -> Request<Body> {
    Request::post(path)
        .header(header::ORIGIN, ORIGIN)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn cors_answers_only_a_paired_origin_and_exactly_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, _) = stub_upstream().await;
    let (state, read, _) = connected(&base, tmp.path(), "-", 1);
    let app = routes(&state).with_state(state);
    let preflight = |origin: &str| {
        Request::options("/v1/tailnet/devices")
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .header("access-control-request-private-network", "true")
            .body(Body::empty())
            .unwrap()
    };
    let (status, headers, _) = send(&app, preflight(ORIGIN)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
    assert_eq!(headers["access-control-allow-private-network"], "true");
    assert!(headers
        .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
        .is_none());
    let (status, headers, _) = send(&app, preflight("https://evil.example")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    let (_, headers, _) = send(&app, get("/v1/tailnet/status", ORIGIN, Some(&read))).await;
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
    assert_eq!(headers[header::VARY], "Origin");
}

#[tokio::test]
async fn a_bearer_works_only_from_its_origin_and_forgets_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, _) = stub_upstream().await;
    let (state, read, _) = connected(&base, tmp.path(), "-", 1);
    let app = routes(&state).with_state(state);
    let (status, _, body) = send(
        &app,
        get("/v1/tailnet/status", "https://evil.example", Some(&read)),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "tailnet_pairing_required");
    let forget = |token: &str| {
        Request::delete("/v1/tailnet/pairing")
            .header(header::ORIGIN, ORIGIN)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(send(&app, forget(&read)).await.0, StatusCode::NO_CONTENT);
    assert_eq!(send(&app, forget(&read)).await.0, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(&app, get("/v1/tailnet/status", ORIGIN, Some(&read))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_code_is_traded_through_the_route_once_and_only_from_its_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, _) = stub_upstream().await;
    let (state, _, _) = connected(&base, tmp.path(), "-", 1);
    let store = state.tailnet.store.clone().unwrap();
    let app = routes(&state).with_state(state);
    let trade = |origin: &str, code: &str| {
        Request::post("/v1/tailnet/pairing")
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "code": code }).to_string()))
            .unwrap()
    };
    let (code, _) = store
        .pairings()
        .issue(ORIGIN, Role::Manage, "desk", unix_now())
        .unwrap();
    let (status, _, body) = send(&app, trade(ORIGIN, &code)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["role"], "manage");
    assert_eq!(body["label"], "desk");
    let token = body["token"].as_str().unwrap().to_string();
    assert_eq!(
        send(&app, trade(ORIGIN, &code)).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, _, body) = send(&app, get("/v1/tailnet/status", ORIGIN, Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["role"], "manage");
    let (other, _) = store
        .pairings()
        .issue(ORIGIN, Role::Read, "", unix_now())
        .unwrap();
    let (status, _, body) = send(&app, trade("https://evil.example", &other)).await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::FORBIDDEN, json!("pairing_refused"))
    );
    assert_eq!(
        send(&app, trade(ORIGIN, &other)).await.0,
        StatusCode::FORBIDDEN,
        "spent"
    );
    let no_origin = Request::post("/v1/tailnet/pairing")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "code": code }).to_string()))
        .unwrap();
    assert_eq!(send(&app, no_origin).await.2["error"], "origin_required");
}

#[tokio::test]
async fn an_oauth_client_is_traded_for_a_token_and_retraded_after_a_401() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, stub) = stub_upstream().await;
    let store = AdminStore::at(tmp.path());
    let secret = SecretString::from("tskey-client-kOAUTH1CNTRL-0123456789abcdef".to_string());
    let credential = Credential {
        kind: CredentialKind::Oauth,
        client_id: "kOAUTH1CNTRL".into(),
    };
    store.connect("-", credential, &secret, 1).unwrap();
    let (code, _) = store
        .pairings()
        .issue(ORIGIN, Role::Manage, "", unix_now())
        .unwrap();
    let (_, token) = store
        .pairings()
        .exchange(&code, ORIGIN, unix_now())
        .unwrap();
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.tailnet = TailnetAdminHost::at(Some(store), Upstream::loopback(&base).unwrap());
    let app = routes(&state).with_state(state);
    let mint = |n: u32| {
        json!({"method": "POST", "path": "/api/v2/oauth/token", "body": null, "status": 200,
        "response": {"access_token": format!("tskey-api-minted{n}-abcdefgh"), "expires_in": 3600}})
    };
    let devices = |status: u16| {
        json!({"method": "GET", "path": "/api/v2/tailnet/-/devices?fields=all",
        "body": null, "status": status, "response": {"devices": []}})
    };
    {
        let mut stub = stub.lock().unwrap();
        stub.bearer = None;
        stub.expected = [mint(1), devices(200), devices(401), mint(2), devices(200)].into();
    }
    for _ in 0..2 {
        let (status, _, body) = send(&app, get("/v1/tailnet/devices", ORIGIN, Some(&token))).await;
        assert_eq!((status, body), (StatusCode::OK, json!({"devices": []})));
    }
    let stub = stub.lock().unwrap();
    assert!(stub.problems.is_empty(), "{:?}", stub.problems);
    assert!(stub.expected.is_empty());
    assert!(stub.seen[0].1.contains("client_id=kOAUTH1CNTRL"));
    assert!(stub.seen[0].1.contains("grant_type=client_credentials"));
    assert!(
        !stub.seen[1].1.contains("tskey-"),
        "the API call carries no secret in its body"
    );
}

#[tokio::test]
async fn an_oauth_key_without_tags_is_refused_before_it_is_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, stub) = stub_upstream().await;
    let (state, _, manage) = connected(&base, tmp.path(), "-", 1);
    let store = state.tailnet.store.clone().unwrap();
    let credential = Credential {
        kind: CredentialKind::Oauth,
        client_id: "kOAUTH1CNTRL".into(),
    };
    let secret = SecretString::from("tskey-client-kOAUTH1CNTRL-0123456789abcdef".to_string());
    store.connect("-", credential, &secret, 1).unwrap();
    let app = routes(&state).with_state(state);
    let body = json!({"description": "x", "expiry_seconds": 86400});
    let (status, _, answered) = send(&app, post("/v1/tailnet/keys", &manage, &body)).await;
    assert_eq!(
        (status, answered["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("tags_required"))
    );
    assert!(stub.lock().unwrap().seen.is_empty());
    assert!(store.audit().recent(10).unwrap().is_empty());
}

#[tokio::test]
async fn tailscale_rate_limits_and_a_bearer_has_a_budget() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, stub) = stub_upstream().await;
    let (mut state, _, manage) = connected(&base, tmp.path(), "-", 1);
    state.tailnet.change_limiter = Arc::new(TokenBucket::new(1.0, 0.001));
    let app = routes(&state).with_state(state);
    stub.lock().unwrap().expected = [json!({"method": "POST", "path": "/api/v2/device/n1/expire",
        "body": null, "status": 429, "response": {"message": "slow down"}})]
    .into();
    let request = || post("/v1/tailnet/devices/n1/expire", &manage, &Value::Null);
    let (status, headers, body) = send(&app, request()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, json!({"error": "rate_limited", "retry_after": 30}));
    assert_eq!(headers[header::RETRY_AFTER], "30");
    let (status, _, _) = send(&app, request()).await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "the bearer's own budget is spent"
    );
    assert!(stub.lock().unwrap().expected.is_empty());
}

#[tokio::test]
async fn the_audit_route_reads_newest_first_and_a_daemon_without_state_refuses() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, stub) = stub_upstream().await;
    let (state, read, manage) = connected(&base, tmp.path(), "-", 1);
    let app = routes(&state).with_state(state);
    stub.lock().unwrap().expected = [json!({"method": "DELETE", "path": "/api/v2/device/n9",
        "body": null, "status": 200, "response": null})]
    .into();
    let delete = Request::delete("/v1/tailnet/devices/n9")
        .header(header::ORIGIN, ORIGIN)
        .header(header::AUTHORIZATION, format!("Bearer {manage}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, delete).await.0, StatusCode::NO_CONTENT);
    let (status, _, body) = send(&app, get("/v1/tailnet/audit?limit=5", ORIGIN, Some(&read))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["entries"][0]["action"], "device.delete");
    assert_eq!(body["entries"][0]["target"], "n9");

    let stateless = crate::tests::test_state("http://127.0.0.1:1");
    let app = routes(&stateless).with_state(stateless);
    let (status, _, body) = send(&app, get("/v1/tailnet/status", ORIGIN, Some(&read))).await;
    assert_eq!(
        (status, body["error"].clone()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!("tailnet_admin_unavailable")
        )
    );
}

#[tokio::test]
async fn a_disconnected_tailnet_says_so() {
    let tmp = tempfile::tempdir().unwrap();
    let (base, _) = stub_upstream().await;
    let (state, read, _) = connected(&base, tmp.path(), "-", 1);
    state.tailnet.store.as_ref().unwrap().disconnect().unwrap();
    let app = routes(&state).with_state(state);
    let (status, _, body) = send(&app, get("/v1/tailnet/status", ORIGIN, Some(&read))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["connected"], false);
    let (status, _, body) = send(&app, get("/v1/tailnet/devices", ORIGIN, Some(&read))).await;
    assert_eq!(
        (status, body["error"].clone()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!("tailnet_not_connected")
        )
    );
}
