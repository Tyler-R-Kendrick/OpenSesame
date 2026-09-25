//! The drive against `spec/conformance/vault-drive-protocol.json` (ADR 0144):
//! every exchange replayed, in order, against the real router and store. The
//! Pages client is held to the same file, so a change on either side that the
//! other does not follow fails a test rather than a sync.
use super::*;
use crate::vault_drive::{MAX_SLOTS, MAX_SNAPSHOT_BYTES, SNAPSHOT_FORMAT};
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use tower::ServiceExt;

const SPEC: &str = include_str!("../../../spec/conformance/vault-drive-protocol.json");

fn spec() -> Value {
    serde_json::from_str(SPEC).expect("the drive protocol spec is JSON")
}

/// `"$name"` → `snapshots[name]`, anywhere in a value.
fn resolve(value: &Value, snapshots: &Value) -> Value {
    match value {
        Value::String(text) if text.starts_with('$') => snapshots[&text[1..]].clone(),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, inner)| (key.clone(), resolve(inner, snapshots)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[tokio::test]
async fn the_drive_answers_every_exchange_the_spec_records() {
    let spec = spec();
    let dir = std::env::temp_dir().join(format!(
        "opensesame-vault-drive-conformance-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Arc::new(DriveStore::new(dir.clone()));
    let (view, key) = store.create("Laptop").unwrap();
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.vault_drive = Some(store);
    let app = routes().with_state(state);
    let path = spec["path"].as_str().unwrap().replace("{slot}", &view.slot);
    let wrong = "w".repeat(43);

    for exchange in spec["exchanges"].as_array().unwrap() {
        let name = exchange["name"].as_str().unwrap();
        let request = &exchange["request"];
        let bearer = match request["key"].as_str().unwrap() {
            "slot" => key.as_str(),
            _ => wrong.as_str(),
        };
        let body = request
            .get("body")
            .map(|body| resolve(body, &spec["snapshots"]).to_string())
            .unwrap_or_default();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(request["method"].as_str().unwrap())
                    .uri(&path)
                    .header("authorization", format!("Bearer {bearer}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let expected = &exchange["response"];
        assert_eq!(
            u64::from(status),
            expected["status"].as_u64().unwrap(),
            "{name}: status"
        );
        assert_eq!(
            answer,
            resolve(&expected["body"], &spec["snapshots"]),
            "{name}: body"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_daemon_prints_the_pairing_code_the_spec_records() {
    let spec = spec();
    let pairing = &spec["pairing"];
    assert_eq!(pairing["prefix"], PAIRING_PREFIX);
    assert_eq!(
        pairing_code(
            pairing["url"].as_str().unwrap(),
            pairing["slot"].as_str().unwrap(),
            pairing["key"].as_str().unwrap(),
            pairing["label"].as_str().unwrap(),
        ),
        pairing["code"].as_str().unwrap()
    );
}

#[test]
fn the_daemon_enforces_the_limits_and_format_the_spec_records() {
    let spec = spec();
    assert_eq!(spec["snapshotFormat"], SNAPSHOT_FORMAT);
    assert_eq!(
        spec["limits"]["maxSnapshotBytes"].as_u64(),
        Some(MAX_SNAPSHOT_BYTES as u64)
    );
    assert_eq!(spec["limits"]["maxSlots"].as_u64(), Some(MAX_SLOTS as u64));
}
