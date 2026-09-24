use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use tower::ServiceExt;

fn app(name: &str) -> (Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "opensesame-vault-drive-routes-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.vault_drive = Some(Arc::new(DriveStore::new(dir.clone())));
    (routes().with_state(state), dir)
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn operator(method: &str, uri: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("x-opensesame-operator", crate::test_operator_token())
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn device(method: &str, slot: &str, key: &str, body: Option<&Value>) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(format!("/v1/vault-drive/slots/{slot}/snapshot"))
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap()
}

fn snapshot(rev: u64) -> Value {
    json!({ "format": vault_drive::SNAPSHOT_FORMAT, "v": 1, "rev": rev })
}

/// Open a slot the way `opensesame vault-drive create` does; returns (slot, key).
async fn open_slot(app: &Router) -> (String, String) {
    let (status, body) = call(
        app,
        operator(
            "POST",
            "/v1/vault-drive/slots",
            &json!({ "label": "Phone", "url": "https://desk.tail1.ts.net" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let code = body["pairing_code"].as_str().unwrap();
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(code.strip_prefix(PAIRING_PREFIX).unwrap())
        .unwrap();
    let pairing: Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(pairing["url"], "https://desk.tail1.ts.net");
    assert_eq!(pairing["label"], "Phone");
    (
        pairing["slot"].as_str().unwrap().to_string(),
        pairing["key"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn a_device_reads_and_replaces_by_generation() {
    let (app, dir) = app("cas");
    let (slot, key) = open_slot(&app).await;
    let (status, body) = call(&app, device("GET", &slot, &key, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "generation": 0, "snapshot": null }));

    let put = json!({ "expected_generation": 0, "snapshot": snapshot(1) });
    let (status, body) = call(&app, device("PUT", &slot, &key, Some(&put))).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "generation": 1 })));

    let (status, body) = call(&app, device("PUT", &slot, &key, Some(&put))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["generation"], 1);

    let (_, body) = call(&app, device("GET", &slot, &key, None)).await;
    assert_eq!(body, json!({ "generation": 1, "snapshot": snapshot(1) }));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn device_routes_want_the_slot_key_not_the_operator_token() {
    let (app, dir) = app("auth");
    let (slot, _key) = open_slot(&app).await;
    let (status, _) = call(&app, device("GET", &slot, &"z".repeat(43), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &app,
        device(
            "GET",
            &slot,
            &format!("operator:{}", crate::test_operator_token()),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_drive_refuses_what_is_not_a_vault_snapshot() {
    let (app, dir) = app("shape");
    let (slot, key) = open_slot(&app).await;
    let put = json!({ "expected_generation": 0, "snapshot": { "plaintext": "hunter2" } });
    let (status, body) = call(&app, device("PUT", &slot, &key, Some(&put))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "not_a_vault_snapshot");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_browser_cannot_open_or_list_slots() {
    let (app, dir) = app("browser");
    let mut request = operator("POST", "/v1/vault-drive/slots", &json!({ "url": "https://x.ts.net" }));
    request
        .headers_mut()
        .insert("origin", "https://tyler-r-kendrick.github.io".parse().unwrap());
    let (status, _) = call(&app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &app,
        Request::builder()
            .uri("/v1/vault-drive/slots")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_operator_lists_and_closes_slots() {
    let (app, dir) = app("close");
    let (slot, key) = open_slot(&app).await;
    let (status, body) = call(&app, operator("GET", "/v1/vault-drive/slots", &json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["slots"][0]["slot"], slot);
    assert!(!body.to_string().contains(&key));
    let uri = format!("/v1/vault-drive/slots/{slot}");
    let (status, _) = call(&app, operator("DELETE", &uri, &json!({}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(&app, device("GET", &slot, &key, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_unconfigured_drive_says_so() {
    let state = crate::tests::test_state("http://127.0.0.1:1");
    let app = routes().with_state(state);
    let (status, body) = call(&app, device("GET", "slot-0000aaaa", &"k".repeat(43), None)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "vault_drive_unconfigured");
}
