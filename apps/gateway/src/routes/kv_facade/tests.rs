//! Route, contract, adversarial and structural tests for the KV v2 facade.
//!
//! Everything here is offline and deterministic: connections are inserted as
//! rows, the mint path is exercised only through providers that refuse before
//! any HTTP client is built, and no test reaches the network.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use opensesame_connection_broker::{store, store::ConnectionRow, ConnectionStatus};
use opensesame_domain::{EgressBinding, OrganizationId, OrganizationRole, ReceiptId};
use serde_json::Value;
use tower::ServiceExt;

use super::path::{kv_path_is_confined, parse_kv_path, KvFamily, KvPathError};
use crate::app_state::{self, AppState};

// ---- harness ---------------------------------------------------------------

/// The facade's own route group over a demo-bootstrapped state. Mounting the
/// group directly keeps these tests independent of the process-wide flag,
/// which is covered by its own pair of tests below.
async fn facade() -> (Router, AppState) {
    let state = app_state::test_demo_state().await;
    let router = super::routes().with_state(state.clone());
    (router, state)
}

fn boot_org(state: &AppState) -> OrganizationId {
    state.bootstrap.lock().unwrap().clone().unwrap().org
}

/// The organization an operator's reads resolve to (`Caller::Operator` has no
/// organization of its own, so it falls back to the deployment's). The row is
/// created here because this harness builds state without the demo bootstrap
/// that would otherwise have made it, and receipts reference it.
async fn operator_org(state: &AppState) -> OrganizationId {
    let organization_id = state.connection_organization;
    let _ = state
        .db
        .create_organization(&organization_id, "operator-default")
        .await;
    organization_id
}

/// Inserts a connection row directly. The facade is a *view*, so the fixture
/// is the storage the view reads, not a request that would create it.
async fn seed_connection(
    state: &AppState,
    organization_id: &OrganizationId,
    logical_name: &str,
    provider_id: &str,
    owner_subject: Option<&str>,
    materialization: &str,
) -> String {
    let id = format!("conn_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    store::insert_connection(
        state.db.pool(),
        &ConnectionRow {
            id: id.clone(),
            organization_id: organization_id.to_string(),
            project_id: None,
            provider_id: provider_id.to_string(),
            // `deployment:` integrations are the convention for connections
            // bound to deployment-level provider config rather than an
            // organization integration row (migration 0004's guard).
            integration_id: format!("deployment:{provider_id}"),
            logical_name: logical_name.to_string(),
            display_name: logical_name.to_string(),
            status: ConnectionStatus::Active,
            status_detail: None,
            requested_scopes: vec!["repo".into()],
            granted_scopes: vec!["repo".into()],
            account_label: None,
            owner_kind: "user".into(),
            owner_subject: owner_subject.map(str::to_string),
            shareability: "private".into(),
            max_invoke_level: 2,
            materialization: materialization.to_string(),
            egress: EgressBinding::default(),
            created_at: now,
            updated_at: now,
        },
    )
    .await
    .expect("seed connection");
    id
}

/// A session, plus the raw opaque token to present as `X-Vault-Token`.
fn session(state: &AppState, subject: &str, organization_id: OrganizationId) -> String {
    let headers = app_state::test_session_headers(
        state,
        subject,
        organization_id,
        OrganizationRole::Owner,
    );
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .expect("session bearer")
        .to_string()
}

async fn call(router: &Router, method: &str, uri: &str, token: Option<&str>) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("X-Vault-Token", token);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let receipt = response
        .headers()
        .get(super::RECEIPT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body, receipt)
}

async fn receipt_count(state: &AppState) -> i64 {
    state.db.count_receipts().await.expect("count receipts")
}

// ---- flag gating -----------------------------------------------------------

#[tokio::test]
async fn flag_off_leaves_the_surface_absent_rather_than_forbidden() {
    let state = app_state::test_demo_state().await;
    let router = {
        let _guard = app_state::test_env::lock();
        std::env::remove_var("OPENSESAME_KV_FACADE");
        crate::routes::router(state.clone())
    };
    for (method, uri) in [
        ("GET", "/v1/sys/health"),
        ("GET", "/v1/secret/data/connections/anything"),
        ("GET", "/v1/secret/metadata/connections/anything"),
        ("POST", "/v1/secret/data/connections/anything"),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{method} {uri} must not exist when the flag is off"
        );
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        // An unmounted route is axum's own empty 404, never the facade's
        // roadmap body — the difference is what stops it confirming the
        // surface exists.
        assert!(
            !String::from_utf8_lossy(&bytes).contains("read-only"),
            "flag-off 404 leaked the facade's own body"
        );
    }
}

#[tokio::test]
async fn the_flag_mounts_the_facade_into_the_main_router() {
    let state = app_state::test_demo_state().await;
    let router = {
        let _guard = app_state::test_env::lock();
        std::env::set_var("OPENSESAME_KV_FACADE", "1");
        let router = crate::routes::router(state.clone());
        std::env::remove_var("OPENSESAME_KV_FACADE");
        router
    };
    let (status, body, _) = call(&router, "GET", "/v1/sys/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sealed"], Value::Bool(false));
    assert_eq!(body["initialized"], Value::Bool(true));
}

// ---- auth ------------------------------------------------------------------

#[tokio::test]
async fn a_missing_vault_token_is_refused_before_anything_is_read() {
    let (router, state) = facade().await;
    let organization_id = boot_org(&state);
    seed_connection(&state, &organization_id, "gh-prod", "github", None, "deny").await;
    let before = receipt_count(&state).await;

    let (status, body, receipt) =
        call(&router, "GET", "/v1/secret/data/connections/gh-prod", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errors"][0], "missing client token");
    assert!(receipt.is_none());
    assert!(!body.to_string().contains("connection_ref"));
    assert_eq!(receipt_count(&state).await, before, "no receipt for a refusal");
}

#[tokio::test]
async fn an_invalid_vault_token_is_permission_denied() {
    let (router, state) = facade().await;
    let organization_id = boot_org(&state);
    seed_connection(&state, &organization_id, "gh-prod", "github", None, "deny").await;

    for token in [
        "not-a-token",
        "opaque-session:00000000-0000-0000-0000-000000000000",
        "   ",
    ] {
        let (status, body, _) = call(
            &router,
            "GET",
            "/v1/secret/data/connections/gh-prod",
            Some(token),
        )
        .await;
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::BAD_REQUEST,
            "token {token:?} produced {status}"
        );
        assert!(!body.to_string().contains("connection_ref"), "{body}");
    }
}

// ---- reads -----------------------------------------------------------------

#[tokio::test]
async fn a_session_token_reads_the_kv_v2_envelope_and_gets_a_receipt() {
    let (router, state) = facade().await;
    let organization_id = boot_org(&state);
    let subject = "prn_kv_reader";
    let token = session(&state, subject, organization_id);
    seed_connection(
        &state,
        &organization_id,
        "gh-prod",
        "github",
        Some(subject),
        "deny",
    )
    .await;

    let (status, body, receipt_id) = call(
        &router,
        "GET",
        "/v1/secret/data/connections/gh-prod",
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Envelope shape, exactly as a Vault KV v2 client expects it.
    for key in [
        "request_id",
        "lease_id",
        "renewable",
        "lease_duration",
        "data",
        "wrap_info",
        "warnings",
        "auth",
        "mount_type",
    ] {
        assert!(body.get(key).is_some(), "envelope missing {key}: {body}");
    }
    assert_eq!(body["mount_type"], "kv");
    assert_eq!(body["renewable"], Value::Bool(false));
    let metadata = &body["data"]["metadata"];
    assert_eq!(metadata["destroyed"], Value::Bool(false));
    assert_eq!(metadata["deletion_time"], "");
    assert!(metadata["version"].as_u64().unwrap() >= 1);
    let data = &body["data"]["data"];
    assert_eq!(data["provider_id"], "github");
    assert_eq!(data["logical_name"], "gh-prod");
    assert_eq!(data["materialization"], "deny");
    assert!(data["connection_ref"].as_str().unwrap().starts_with("conn://"));
    // Reference-only: the reference view carries no credential bytes.
    assert!(data.get("derived_token").is_none());

    // The receipt is real evidence: it is stored, it verifies, and it names
    // the read without naming what was read.
    let receipt_id = ReceiptId::parse(&receipt_id.expect("receipt header")).expect("receipt id");
    let stored = state
        .db
        .get_receipt(&receipt_id)
        .await
        .expect("load receipt")
        .expect("receipt row");
    state
        .receipt_verifier
        .verify(&stored.receipt)
        .expect("receipt verifies");
    assert_eq!(stored.receipt.operation, "kv.read");
    assert_eq!(
        stored.receipt.resource,
        "kv/v2/secret/connections/gh-prod"
    );
    let summary = stored.receipt.safe_result_summary.clone().unwrap();
    assert_eq!(summary["family"], "connections");
    assert!(summary["keys"].as_u64().unwrap() > 0);
    // Counts, never key names.
    assert!(summary.get("configured_fields").is_none());
    assert!(!summary.to_string().contains("granted_scopes"));
}

#[tokio::test]
async fn an_operator_token_reads_the_same_surface() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-ops", "github", None, "deny").await;

    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/data/connections/gh-ops",
        Some(&operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["data"]["logical_name"], "gh-ops");
    assert!(receipt.is_some());
}

#[tokio::test]
async fn metadata_reads_are_kv_v2_shaped_and_receipted() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-meta", "github", None, "deny").await;
    let before = receipt_count(&state).await;

    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/metadata/connections/gh-meta",
        Some(&operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    for key in [
        "cas_required",
        "created_time",
        "current_version",
        "custom_metadata",
        "delete_version_after",
        "max_versions",
        "oldest_version",
        "updated_time",
        "versions",
    ] {
        assert!(data.get(key).is_some(), "metadata missing {key}: {body}");
    }
    let versions = data["versions"].as_object().expect("versions object");
    assert!(!versions.is_empty());
    for version in versions.values() {
        assert_eq!(version["destroyed"], Value::Bool(false));
        assert_eq!(version["deletion_time"], "");
        assert!(version["created_time"].is_string());
    }
    assert!(receipt.is_some());
    assert_eq!(receipt_count(&state).await, before + 1);
}

#[tokio::test]
async fn a_connection_owned_by_someone_else_reads_as_absent() {
    let (router, state) = facade().await;
    let organization_id = boot_org(&state);
    let token = session(&state, "prn_intruder", organization_id);
    seed_connection(
        &state,
        &organization_id,
        "gh-private",
        "github",
        Some("prn_owner"),
        "deny",
    )
    .await;

    let (status, body, _) = call(
        &router,
        "GET",
        "/v1/secret/data/connections/gh-private",
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["errors"].as_array().unwrap().len(), 0);
}

// ---- write verbs -----------------------------------------------------------

#[tokio::test]
async fn every_write_verb_is_refused_with_the_roadmap_answer() {
    let (router, state) = facade().await;
    let operator = state.operator_token.clone();
    for (method, uri) in [
        ("POST", "/v1/secret/data/connections/gh"),
        ("PUT", "/v1/secret/data/connections/gh"),
        ("PATCH", "/v1/secret/data/connections/gh"),
        ("DELETE", "/v1/secret/data/connections/gh"),
        ("POST", "/v1/secret/metadata/connections/gh"),
        ("DELETE", "/v1/secret/metadata/connections/gh"),
        ("POST", "/v1/secret/delete/connections/gh"),
        ("POST", "/v1/secret/undelete/connections/gh"),
        ("PUT", "/v1/secret/destroy/connections/gh"),
    ] {
        let (status, body, _) = call(&router, method, uri, Some(&operator)).await;
        assert_eq!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {uri} was not refused"
        );
        assert!(
            body["errors"][0].as_str().unwrap().contains("read-only"),
            "{method} {uri}: {body}"
        );
    }
}

// ---- path confinement ------------------------------------------------------

#[tokio::test]
async fn unresolvable_paths_are_indistinguishable_vault_404s() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-prod", "github", None, "deny").await;
    let before = receipt_count(&state).await;

    for uri in [
        // unknown mount
        "/v1/other/data/connections/gh-prod",
        // unknown family
        "/v1/secret/data/vaults/gh-prod",
        // traversal, encoded and plain
        "/v1/secret/data/connections/..%2f..%2fetc%2fpasswd",
        "/v1/secret/data/connections/../../etc/passwd",
        "/v1/secret/data/../../../etc/passwd",
        // too many segments
        "/v1/secret/data/connections/gh-prod/extra",
        // absent connection
        "/v1/secret/data/connections/does-not-exist",
    ] {
        let (status, body, receipt) = call(&router, "GET", uri, Some(&operator)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body["errors"].as_array().unwrap().len(), 0, "{uri}");
        assert!(receipt.is_none(), "{uri}");
        assert!(!body.to_string().contains("gh-prod"), "{uri}");
    }
    assert_eq!(receipt_count(&state).await, before, "404s mint no receipts");
}

// ---- materialization -------------------------------------------------------

#[tokio::test]
async fn materialize_is_refused_while_the_policy_says_deny() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-deny", "github", None, "deny").await;
    let before = receipt_count(&state).await;

    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/data/materialize/gh-deny",
        Some(&operator),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body["errors"][0].as_str().unwrap().contains("0049"), "{body}");
    assert!(receipt.is_none());
    assert_eq!(receipt_count(&state).await, before);
}

#[tokio::test]
async fn materialize_refuses_a_provider_with_no_mint_path_without_dialling_it() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(
        &state,
        &organization_id,
        "aws-prod",
        "aws",
        None,
        "derived_short_lived",
    )
    .await;

    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/data/materialize/aws-prod",
        Some(&operator),
    )
    .await;
    // 422 is the broker's own answer for "this provider cannot mint"; the
    // refusal happens before any HTTP client is built, so the test is offline.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(receipt.is_none());
    assert!(!body.to_string().contains("derived_token"));
}

// ---- fail-closed accountability -------------------------------------------

#[tokio::test]
async fn a_read_whose_receipt_cannot_be_recorded_is_refused() {
    let (router, state) = facade().await;
    // An organization the Host has no row for: the receipt's intent cannot
    // reference it, so the read must fail closed rather than serve unrecorded.
    let orphan = OrganizationId::new();
    let subject = "prn_orphan";
    let token = session(&state, subject, orphan);
    seed_connection(&state, &orphan, "gh-orphan", "github", Some(subject), "deny").await;

    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/data/connections/gh-orphan",
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(receipt.is_none());
    assert!(!body.to_string().contains("connection_ref"), "{body}");
}

// ---- contract: byte-shape against real Vault responses ---------------------

/// Sample responses from HashiCorp's public KV v2 API reference
/// (`developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2`), committed so the
/// envelope this facade emits is diffed against Vault's documented shape rather
/// than against itself.
const VAULT_READ_FIXTURE: &str = include_str!("fixtures/vault_kv_v2_read.json");
const VAULT_METADATA_FIXTURE: &str = include_str!("fixtures/vault_kv_v2_metadata.json");

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Every key the fixture documents exists in `actual` with the same JSON type.
/// `null` in either position is accepted: KV v2 sends `null` for absent
/// optional maps such as `custom_metadata`.
fn assert_shape_matches(fixture: &Value, actual: &Value, at: &str) {
    let expected = fixture.as_object().unwrap_or_else(|| panic!("{at} object"));
    let got = actual
        .as_object()
        .unwrap_or_else(|| panic!("{at} missing in facade response"));
    for (key, value) in expected {
        let found = got
            .get(key)
            .unwrap_or_else(|| panic!("{at}.{key} missing from the facade response"));
        if value.is_null() || found.is_null() {
            continue;
        }
        assert_eq!(
            type_name(value),
            type_name(found),
            "{at}.{key} type differs from Vault's"
        );
    }
}

#[tokio::test]
async fn the_read_envelope_matches_a_real_vault_kv_v2_response() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-shape", "github", None, "deny").await;

    let (status, body, _) = call(
        &router,
        "GET",
        "/v1/secret/data/connections/gh-shape",
        Some(&operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let fixture: Value = serde_json::from_str(VAULT_READ_FIXTURE).unwrap();
    assert_shape_matches(&fixture["data"], &body["data"], "data");
    assert_shape_matches(
        &fixture["data"]["metadata"],
        &body["data"]["metadata"],
        "data.metadata",
    );
    // `data.data` is a free-form string map in KV v2; the facade's keys differ
    // from the fixture's by design, but the container type may not.
    assert!(body["data"]["data"].is_object());
}

#[tokio::test]
async fn the_metadata_envelope_matches_a_real_vault_kv_v2_response() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-shape2", "github", None, "deny").await;

    let (status, body, _) = call(
        &router,
        "GET",
        "/v1/secret/metadata/connections/gh-shape2",
        Some(&operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let fixture: Value = serde_json::from_str(VAULT_METADATA_FIXTURE).unwrap();
    assert_shape_matches(&fixture["data"], &body["data"], "data");
    let fixture_version = &fixture["data"]["versions"]["1"];
    let actual_version = &body["data"]["versions"]["1"];
    assert_shape_matches(fixture_version, actual_version, "data.versions.1");
}

/// The self-conformance loop: OpenSesame's own Vault client
/// (`crates/provider-openbao`, the client half of this protocol) reads a
/// secret through the facade over loopback. If the envelope drifts, this test
/// fails where a hand-written assertion would not.
#[tokio::test]
async fn our_own_vault_client_can_read_through_the_facade() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(&state, &organization_id, "gh-loop", "github", None, "deny").await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    let authority =
        opensesame_provider_openbao::OpenBaoHttpAuthority::new(format!("http://{addr}"), operator);
    let data = authority
        .kv_get("secret", "connections/gh-loop")
        .await
        .expect("our Vault client reads our Vault facade");
    assert_eq!(data["logical_name"], "gh-loop");
    assert!(data["connection_ref"].as_str().unwrap().starts_with("conn://"));
    server.abort();
}

// ---- pure path grammar -----------------------------------------------------

#[test]
fn the_path_grammar_accepts_only_confined_two_segment_paths() {
    let parsed = parse_kv_path("secret", "connections/gh-prod").expect("valid path");
    assert_eq!(parsed.family, KvFamily::Connections);
    assert_eq!(parsed.name, "gh-prod");
    assert!(kv_path_is_confined(&parsed));

    let parsed = parse_kv_path("secret", "materialize/aws.prod_1").expect("valid path");
    assert_eq!(parsed.family, KvFamily::Materialize);
    assert!(kv_path_is_confined(&parsed));

    assert_eq!(
        parse_kv_path("other", "connections/gh"),
        Err(KvPathError::UnknownMount)
    );
    assert_eq!(
        parse_kv_path("secret", "vaults/gh"),
        Err(KvPathError::UnknownFamily)
    );
    for malformed in [
        "connections",
        "connections/",
        "/gh",
        "connections/gh/extra",
        "",
        "//",
    ] {
        assert!(
            parse_kv_path("secret", malformed).is_err(),
            "{malformed:?} parsed"
        );
    }
    for hostile in [
        "connections/..",
        "connections/../etc/passwd",
        "connections/.hidden",
        "connections/a..b",
        "connections/a b",
        "connections/a\0b",
        "connections/a\\b",
        "connections/a%2fb",
        "connections/a:b",
    ] {
        assert!(parse_kv_path("secret", hostile).is_err(), "{hostile:?} parsed");
    }
    let long = format!("connections/{}", "a".repeat(129));
    assert_eq!(
        parse_kv_path("secret", &long),
        Err(KvPathError::InvalidName)
    );
    let huge = format!("connections/{}", "a".repeat(600));
    assert_eq!(parse_kv_path("secret", &huge), Err(KvPathError::TooLong));
}

/// The property the `kv_v2_path` fuzz target asserts, pinned here so a
/// regression fails in `cargo test` too, not only under libFuzzer.
#[test]
fn property_every_accepted_path_is_confined() {
    let alphabet = ["a", "-", "_", ".", "/", "..", "%2f", "\\", "\0", "A1"];
    for first in alphabet {
        for second in alphabet {
            for third in alphabet {
                let raw = format!("connections/{first}{second}{third}");
                if let Ok(parsed) = parse_kv_path("secret", &raw) {
                    assert!(kv_path_is_confined(&parsed), "{raw:?} accepted unconfined");
                }
                let raw = format!("{first}{second}/{third}");
                if let Ok(parsed) = parse_kv_path("secret", &raw) {
                    assert!(kv_path_is_confined(&parsed), "{raw:?} accepted unconfined");
                }
            }
        }
    }
}

// ---- structural pact -------------------------------------------------------

#[test]
fn pact_auth_precedes_storage_and_the_receipt_precedes_the_body() {
    let source = include_str!("../kv_facade.rs");
    // A read authenticates, resolves inside the caller's organization, and only
    // then touches storage.
    opensesame_host_core::pact::assert_source_order(
        source,
        &[
            "async fn read_data",
            "parse_kv_path(&mount, &raw_path)",
            "vault_caller(&st, &headers)",
            "caller.organization(st.connection_organization)",
            "resolve_connection(&st, &caller, &organization_id",
        ],
    );
    // The body is built, the receipt is emitted, and only a recorded receipt
    // produces a 200.
    opensesame_host_core::pact::assert_source_order(
        source,
        &[
            "async fn respond_read",
            "let body = data_envelope(",
            "emit_receipt(",
            "Ok(receipt_id) => with_receipt(receipt_id, body)",
            "Err(response) => response",
        ],
    );
    // Signing happens before persistence, and the leak check before both.
    opensesame_host_core::pact::assert_source_order(
        source,
        &[
            "async fn emit_receipt",
            ".sign_receipt(receipt)",
            "assert_no_secret_leak()",
            "insert_intent(&intent)",
            "insert_receipt(&receipt)",
        ],
    );
    // Nothing on this surface materialises a secret outside the ADR 0049 gate.
    assert!(!source.contains("get_secret"));
    assert!(!source.contains("getSecret"));
    let materialize = source
        .find("async fn materialized_data")
        .expect("materialized_data");
    let gate = source[materialize..]
        .find("MaterializationPolicy::DerivedShortLived")
        .expect("policy gate");
    let mint = source[materialize..]
        .find("mint_derived_token")
        .expect("mint call");
    assert!(gate < mint, "the mint path must be policy-gated first");
}
