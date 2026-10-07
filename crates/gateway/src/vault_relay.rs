//! Relay profile (ADR 0181).
//!
//! Serves `GET /health/live` and the vault-relay slot routes. Every other
//! path is absent. The process does not open the Host database. A browser
//! is admitted by the slot key; this slice checks that key and refuses a
//! binding document that is not empty `vault_relay` snapshot authority.
//! Native mTLS admission of a certificated peer, beyond that startup check,
//! is still the full Host's binding resolver.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::{constant_time_eq, Args};

pub const SNAPSHOT_FORMAT: &str = "opensesame-vault-drive-snapshot";
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const SLOT_KEY: &str = "x-opensesame-slot-key";
const PRINCIPAL: &str = "x-opensesame-principal";
const OWNER_KIND: &str = "x-opensesame-owner-kind";

struct Slot {
    key_sha256: String,
    generation: u64,
    snapshot: Value,
    principal: String,
    owner_kind: String,
}

#[derive(Default)]
struct Store {
    slots: BTreeMap<String, Slot>,
}

type Shared = Arc<Mutex<Store>>;

/// Bindings relay profile will load: empty when no file is set.
///
/// # Errors
///
/// The file cannot be read, or it is not an empty set and not entirely
/// purpose `vault_relay` limited to the two snapshot operations.
pub fn bindings_for_relay(json: Option<&str>) -> Result<(), String> {
    use opensesame_domain::transport::{validate_relay_profile, ServiceBindingSet};
    let set = match json {
        None => ServiceBindingSet::empty(),
        Some(body) => ServiceBindingSet::parse_json(body).map_err(|err| err.to_string())?,
    };
    validate_relay_profile(&set).map_err(|err| err.to_string())
}

fn load_bindings() -> anyhow::Result<()> {
    let path = std::env::var("OPENSESAME_SERVICE_BINDINGS_FILE")
        .ok()
        .filter(|value| !value.is_empty());
    let json = match path {
        None => None,
        Some(path) => Some(
            std::fs::read_to_string(&path)
                .map_err(|err| anyhow::anyhow!("OPENSESAME_SERVICE_BINDINGS_FILE: {err}"))?,
        ),
    };
    bindings_for_relay(json.as_deref()).map_err(anyhow::Error::msg)
}

fn router(store: Shared) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route(
            "/v1/vault-relay/{owner}/{slug}/snapshot",
            get(get_snapshot).put(put_snapshot),
        )
        .route("/v1/org-vaults", get(list_org_vaults))
        .layer(DefaultBodyLimit::max(MAX_SNAPSHOT_BYTES))
        .with_state(store)
}

async fn live() -> &'static str {
    "ok"
}

/// Serve relay profile until the listener stops.
///
/// # Errors
///
/// The binding document is refused, the listen address is not allowed, or
/// the socket cannot be bound.
pub async fn run(args: &Args) -> anyhow::Result<()> {
    load_bindings()?;
    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(%listen, profile = "relay", "opensesame gateway relay listening");
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .map_err(|err| anyhow::anyhow!("bind {listen}: {err}"))?;
    let store = Arc::new(Mutex::new(Store::default()));
    axum::serve(listener, router(store)).await?;
    Ok(())
}

fn valid_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=63).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value != "guest"
}

fn address(owner: &str, slug: &str) -> Option<String> {
    if valid_segment(owner) && valid_segment(slug) {
        Some(format!("{owner}/{slug}"))
    } else {
        None
    }
}

fn digest_hex(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

fn presented_key(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(SLOT_KEY)?.to_str().ok()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .ok()?;
    if bytes.len() == 32 {
        Some(raw.to_string())
    } else {
        None
    }
}

fn owner_kind_of(headers: &HeaderMap) -> Result<&'static str, StatusCode> {
    match headers
        .get(OWNER_KIND)
        .and_then(|value| value.to_str().ok())
    {
        None | Some("") | Some("user") => Ok("user"),
        Some("organization") => Ok("organization"),
        Some(_) => Err(StatusCode::BAD_REQUEST),
    }
}

fn principal_of(headers: &HeaderMap) -> String {
    headers
        .get(PRINCIPAL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(128)
        .collect()
}

fn snapshot_ok(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("format").and_then(Value::as_str) == Some(SNAPSHOT_FORMAT)
        && object.get("v").and_then(Value::as_u64) == Some(1)
}

fn lock(store: &Shared) -> std::sync::MutexGuard<'_, Store> {
    store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn get_snapshot(
    State(store): State<Shared>,
    Path((owner, slug)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let address = address(&owner, &slug).ok_or(not_found())?;
    let key = presented_key(&headers).ok_or(unauthorized())?;
    let digest = digest_hex(&key);
    let guard = lock(&store);
    let slot = guard.slots.get(&address).ok_or(not_found())?;
    if !constant_time_eq(&slot.key_sha256, &digest) {
        return Err(unauthorized());
    }
    Ok(Json(json!({
        "generation": slot.generation,
        "snapshot": slot.snapshot,
    })))
}

#[derive(Deserialize)]
struct PutBody {
    expected_generation: u64,
    snapshot: Value,
}

async fn put_snapshot(
    State(store): State<Shared>,
    Path((owner, slug)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PutBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let address = address(&owner, &slug).ok_or(not_found())?;
    let owner_kind = owner_kind_of(&headers)
        .map_err(|status| (status, Json(json!({ "error": "malformed" }))))?;
    let key = presented_key(&headers).ok_or(unauthorized())?;
    if !snapshot_ok(&body.snapshot) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed" })),
        ));
    }
    let encoded = serde_json::to_vec(&body.snapshot).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed" })),
        )
    })?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "too_large" })),
        ));
    }
    let digest = digest_hex(&key);
    let principal = principal_of(&headers);
    let mut guard = lock(&store);
    if let Some(slot) = guard.slots.get_mut(&address) {
        if !constant_time_eq(&slot.key_sha256, &digest) {
            return Err(unauthorized());
        }
        if slot.generation != body.expected_generation {
            let generation = slot.generation;
            return Err((
                StatusCode::CONFLICT,
                Json(json!({ "generation": generation })),
            ));
        }
        slot.generation += 1;
        slot.snapshot = body.snapshot;
        let generation = slot.generation;
        return Ok(Json(json!({ "generation": generation })));
    }
    if body.expected_generation != 0 {
        return Err(not_found());
    }
    let generation = 1;
    guard.slots.insert(
        address,
        Slot {
            key_sha256: digest,
            generation,
            snapshot: body.snapshot,
            principal,
            owner_kind: owner_kind.to_string(),
        },
    );
    Ok(Json(json!({ "generation": generation })))
}

fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
}

fn not_found() -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" })))
}

#[derive(Deserialize)]
struct ListQuery {
    principal: Option<String>,
}

async fn list_org_vaults(
    State(store): State<Shared>,
    Query(query): Query<ListQuery>,
) -> Json<Value> {
    let Some(principal) = query.principal.filter(|value| !value.is_empty()) else {
        return Json(json!({ "vaults": [] }));
    };
    let guard = lock(&store);
    let mut vaults = Vec::new();
    for (address, slot) in &guard.slots {
        if slot.principal != principal {
            continue;
        }
        let Some((owner, slug)) = address.split_once('/') else {
            continue;
        };
        vaults.push(json!({
            "ownerKind": slot.owner_kind,
            "owner": owner,
            "slug": slug,
        }));
    }
    Json(json!({ "vaults": vaults }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        router(Arc::new(Mutex::new(Store::default())))
    }

    fn key() -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32])
    }

    fn snapshot(tomb: &str) -> Value {
        json!({
            "format": SNAPSHOT_FORMAT,
            "v": 1,
            "tomb": tomb,
            "header": { "v": 1, "createdAt": "2026-10-07T00:00:00Z" },
            "body": { "ivB64": "aXY", "ctB64": "Y2lwaGVydGV4dA" },
            "rev": 1
        })
    }

    async fn call(
        app: Router,
        method: &str,
        uri: &str,
        key: Option<&str>,
        principal: Option<&str>,
        kind: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(key) = key {
            builder = builder.header(SLOT_KEY, key);
        }
        if let Some(principal) = principal {
            builder = builder.header(PRINCIPAL, principal);
        }
        if let Some(kind) = kind {
            builder = builder.header(OWNER_KIND, kind);
        }
        let request = builder
            .header("content-type", "application/json")
            .body(Body::from(
                body.map(|value| value.to_string()).unwrap_or_default(),
            ))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let parsed = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        (status, parsed)
    }

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

    #[test]
    fn empty_bindings_load_and_a_foreign_purpose_does_not() {
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
    }
}
