use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::test_support::{app, call, call_role, key, snapshot};
use super::{bindings_for_relay, install_relay_bindings, router, router_with, Store};

#[tokio::test]
async fn org_vault_list_returns_refs_claimed_for_that_principal() {
    let store = Arc::new(Mutex::new(Store::default()));
    let slot_key = key();
    let (status, _) = call(
        router(Arc::clone(&store)),
        "PUT",
        "/v1/vault-relay/acme/ledger/snapshot",
        Some(&slot_key),
        Some("ada"),
        Some("organization"),
        Some(json!({ "expected_generation": 0, "snapshot": snapshot("prj_ledger") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, listed) = call(
        router(Arc::clone(&store)),
        "GET",
        "/v1/org-vaults?principal=ada",
        None,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed["vaults"],
        json!([{ "ownerKind": "organization", "owner": "acme", "slug": "ledger" }])
    );
    let (status, empty) = call(
        router(store),
        "GET",
        "/v1/org-vaults?principal=",
        None,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["vaults"], json!([]));
}

#[tokio::test]
async fn create_lists_by_owner_and_refuses_a_second_principal() {
    let store = Arc::new(Mutex::new(Store::default()));
    let app = router(Arc::clone(&store));
    let (status, body) = call(
        app,
        "POST",
        "/v1/org-vaults",
        None,
        Some("ada"),
        None,
        Some(json!({
            "ownerKind": "organization",
            "owner": "acme",
            "slug": "ledger",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["vault"],
        json!({ "ownerKind": "organization", "owner": "acme", "slug": "ledger" })
    );

    let (status, listed) = call(
        router(Arc::clone(&store)),
        "GET",
        "/v1/org-vaults?owner=acme",
        None,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["vaults"][0]["slug"], "ledger");

    let (status, _) = call(
        router(Arc::clone(&store)),
        "POST",
        "/v1/org-vaults",
        None,
        Some("bee"),
        None,
        Some(json!({
            "ownerKind": "organization",
            "owner": "acme",
            "slug": "ledger",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _) = call(
        router(store),
        "POST",
        "/v1/org-vaults",
        None,
        None,
        None,
        Some(json!({
            "ownerKind": "user",
            "owner": "guest",
            "slug": "personal",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[test]
fn empty_bindings_install_on_relay_startup_and_a_foreign_purpose_does_not() {
    let installed = install_relay_bindings(None).expect("default empty set");
    assert_eq!(installed.revision, 1);
    assert!(installed.bindings.is_empty());
    assert!(install_relay_bindings(Some(r#"{"revision":1,"bindings":[]}"#,)).is_ok());
    assert!(bindings_for_relay(None).is_ok());
    assert!(bindings_for_relay(Some(r#"{"revision":1,"bindings":[]}"#,)).is_ok());
    let foreign = r#"{
        "revision": 1,
        "bindings": [{
            "id": "b1", "revision": 1, "enabled": true, "revoked": false,
            "scope": "deployment", "trust_profile": { "name": "private-root" },
            "peer": { "dns_name": "client.example" },
            "service_principal": "svc:relay", "purpose": "nats_auth_bridge",
            "allowed_operations": ["vault.relay.snapshot.read"],
            "allowed_audiences": [], "denied_thumbprints": []
        }]
    }"#;
    assert!(bindings_for_relay(Some(foreign)).is_err());
    assert!(install_relay_bindings(Some(foreign)).is_err());
}

fn vault_relay_document() -> String {
    r#"{
        "revision": 1,
        "bindings": [{
            "id": "relay-1",
            "revision": 1,
            "enabled": true,
            "revoked": false,
            "scope": "deployment",
            "trust_profile": { "name": "private-root" },
            "peer": { "dns_name": "client.example" },
            "service_principal": "svc:relay",
            "purpose": "vault_relay",
            "allowed_operations": [
                "vault.relay.snapshot.read",
                "vault.relay.snapshot.write"
            ],
            "allowed_audiences": [],
            "denied_thumbprints": []
        }]
    }"#
    .to_string()
}

#[tokio::test]
async fn relay_profile_refuses_other_bindings_and_advertises_vault_relay() {
    let foreign = r#"{
        "revision": 1,
        "bindings": [{
            "id": "b1", "revision": 1, "enabled": true, "revoked": false,
            "scope": "deployment", "trust_profile": { "name": "private-root" },
            "peer": { "dns_name": "client.example" },
            "service_principal": "svc:relay", "purpose": "nats_auth_bridge",
            "allowed_operations": ["vault.relay.snapshot.read"],
            "allowed_audiences": [], "denied_thumbprints": []
        }]
    }"#;
    let err = install_relay_bindings(Some(foreign)).expect_err("foreign purpose");
    assert!(err.contains("vault_relay"), "{err}");

    let (status, body) = call(app(), "GET", "/health/relay", None, None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["profile"], "relay");
    assert_eq!(body["purpose"], "vault_relay");
    assert_eq!(body["bindings"], "vault_relay");
    assert_eq!(body["document"], "empty");
    assert_eq!(body["durable"], true);

    let (status, live) = call(app(), "GET", "/health/live", None, None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(live, Value::String("ok".into()));

    let (status, _) = call(
        app(),
        "GET",
        "/api/v1/operator/transport/status",
        None,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let set = install_relay_bindings(Some(&vault_relay_document())).expect("vault_relay only");
    assert!(!set.bindings.is_empty());
    let (status, body) = call(
        router_with(Arc::new(Mutex::new(Store::default())), set, None, None),
        "GET",
        "/health/relay",
        None,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bindings"], "vault_relay");
    assert_eq!(body["document"], "vault_relay");
    assert_eq!(body["durable"], true);
}

#[tokio::test]
async fn member_may_list_and_may_not_create_or_publish() {
    let store = Arc::new(Mutex::new(Store::default()));
    let (status, _) = call_role(
        router(Arc::clone(&store)),
        "POST",
        "/v1/org-vaults",
        None,
        Some("ada"),
        None,
        Some("owner"),
        Some(json!({
            "ownerKind": "organization",
            "owner": "acme",
            "slug": "ledger",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, listed) = call_role(
        router(Arc::clone(&store)),
        "GET",
        "/v1/org-vaults?owner=acme",
        None,
        Some("bee"),
        None,
        Some("member"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["vaults"][0]["slug"], "ledger");

    let (status, body) = call_role(
        router(Arc::clone(&store)),
        "POST",
        "/v1/org-vaults",
        None,
        Some("bee"),
        None,
        Some("member"),
        Some(json!({
            "ownerKind": "organization",
            "owner": "acme",
            "slug": "notes",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "forbidden");

    let slot_key = key();
    let (status, body) = call_role(
        router(Arc::clone(&store)),
        "PUT",
        "/v1/vault-relay/acme/ledger/snapshot",
        Some(&slot_key),
        Some("bee"),
        Some("organization"),
        Some("member"),
        Some(json!({
            "expected_generation": 0,
            "snapshot": snapshot("prj_ledger"),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "forbidden");

    let (status, body) = call_role(
        router(Arc::clone(&store)),
        "PUT",
        "/v1/vault-relay/acme/ledger/snapshot",
        Some(&slot_key),
        Some("ada"),
        Some("organization"),
        Some("admin"),
        Some(json!({
            "expected_generation": 0,
            "snapshot": snapshot("prj_ledger"),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["generation"], 1);
}

#[tokio::test]
async fn user_directory_creation_requires_owner_principal() {
    let store = Arc::new(Mutex::new(Store::default()));

    let (status, body) = call(
        router(Arc::clone(&store)),
        "POST",
        "/v1/org-vaults",
        None,
        Some("bee"),
        None,
        Some(json!({
            "ownerKind": "user",
            "owner": "ada",
            "slug": "personal",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let (status, _) = call(
        router(store),
        "POST",
        "/v1/org-vaults",
        None,
        Some("ada"),
        None,
        Some(json!({
            "ownerKind": "user",
            "owner": "ada",
            "slug": "personal",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn owner_namespace_refuses_conflicting_owner_kind() {
    let store = Arc::new(Mutex::new(Store::default()));
    let app = router(Arc::clone(&store));
    let (status, _) = call(
        app,
        "POST",
        "/v1/org-vaults",
        None,
        Some("acme"),
        None,
        Some(json!({
            "ownerKind": "user",
            "owner": "acme",
            "slug": "vault",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = call(
        router(store),
        "POST",
        "/v1/org-vaults",
        None,
        Some("bob"),
        None,
        Some(json!({
            "ownerKind": "organization",
            "owner": "acme",
            "slug": "other",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "owner_kind");
}
