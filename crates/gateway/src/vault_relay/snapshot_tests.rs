use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use base64::Engine;
use serde_json::{json, Value};

use super::admit::{digest_hex, lock};
use super::test_support::{app, call, key, snapshot};
use super::{router, Store, SNAPSHOT_FORMAT};

#[tokio::test]
async fn health_is_ok_and_host_routes_are_absent() {
    let (status, body) = call(app(), "GET", "/health/live", None, None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Value::String("ok".into()));

    for (method, path) in [
        ("POST", "/api/v1/sync/pull"),
        ("PUT", "/api/v1/operator/transport/bindings"),
        ("GET", "/api/v1/health"),
    ] {
        let (status, _) = call(app(), method, path, None, None, None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }
}

#[tokio::test]
async fn second_device_reads_the_ciphertext_the_first_wrote() {
    let store = Arc::new(Mutex::new(Store::default()));
    let slot_key = key();
    let put = json!({
        "expected_generation": 0,
        "snapshot": snapshot("personal"),
    });
    let (status, body) = call(
        router(Arc::clone(&store)),
        "PUT",
        "/v1/vault-relay/ada/personal/snapshot",
        Some(&slot_key),
        Some("ada"),
        Some("user"),
        Some(put),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["generation"], 1);

    let (status, body) = call(
        router(Arc::clone(&store)),
        "GET",
        "/v1/vault-relay/ada/personal/snapshot",
        Some(&slot_key),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["generation"], 1);
    assert_eq!(body["snapshot"]["format"], SNAPSHOT_FORMAT);
    assert_eq!(body["snapshot"]["body"]["ctB64"], "Y2lwaGVydGV4dA");
    assert!(!body.to_string().contains("Bank login"));

    let stale = json!({
        "expected_generation": 0,
        "snapshot": snapshot("personal"),
    });
    let (status, body) = call(
        router(store),
        "PUT",
        "/v1/vault-relay/ada/personal/snapshot",
        Some(&slot_key),
        Some("ada"),
        None,
        Some(stale),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["generation"], 1);
}

#[tokio::test]
async fn unknown_slot_is_404_and_the_raw_key_is_not_stored() {
    let slot_key = key();
    let (status, body) = call(
        app(),
        "GET",
        "/v1/vault-relay/ada/personal/snapshot",
        Some(&slot_key),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "not_found");

    let store = Arc::new(Mutex::new(Store::default()));
    let (status, _) = call(
        router(Arc::clone(&store)),
        "PUT",
        "/v1/vault-relay/ada/personal/snapshot",
        Some(&slot_key),
        Some("ada"),
        None,
        Some(json!({ "expected_generation": 0, "snapshot": snapshot("personal") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    {
        let guard = lock(&store);
        let slot = guard.slots.get("ada/personal").unwrap();
        assert_ne!(slot.key_sha256, slot_key);
        assert_eq!(slot.key_sha256, digest_hex(&slot_key));
        assert_eq!(slot.key_sha256.len(), 64);
    }

    let (status, _) = call(
        router(Arc::clone(&store)),
        "GET",
        "/v1/vault-relay/ada/personal/snapshot",
        Some(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; 32])),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
