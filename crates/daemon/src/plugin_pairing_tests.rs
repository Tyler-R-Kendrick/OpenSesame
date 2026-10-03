//! The browser road to the plugin routes, attacked: a code used twice, late,
//! from another origin or guessed at speed; a bearer carried to another
//! origin, to another route, or kept after unpair; CORS for anyone else.

use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use opensesame_plugin_settings::{sha256_file, PluginSettings, CODE_TTL_SECS};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;

const PAGES: &str = "https://tyler-r-kendrick.github.io";
const OTHER: &str = "https://attacker.example";

struct Fixture {
    dir: tempfile::TempDir,
    app: Router,
}

impl Fixture {
    fn settings(&self) -> PathBuf {
        self.dir.path().join("plugins.json")
    }

    fn pairings(&self) -> PluginPairings {
        PluginPairings::beside(&self.settings())
    }

    /// `opensesame plugins pair --origin <origin>`, as the CLI records it.
    fn code_for(&self, origin: &str) -> String {
        self.pairings().issue(origin, unix_now()).unwrap().0
    }

    fn install(&self, id: &str) -> PathBuf {
        let bin = self.dir.path().join(format!("{id}.bin"));
        std::fs::write(&bin, b"plugin").unwrap();
        let mut settings = PluginSettings::load(&self.settings()).unwrap();
        let pin = sha256_file(&bin).unwrap();
        settings
            .record_install(id, "0.1.0", &pin, bin.to_str().unwrap())
            .unwrap();
        settings.save(&self.settings()).unwrap();
        bin
    }

    async fn paired(&self, origin: &str) -> String {
        let code = self.code_for(origin);
        let (status, body, _) = call(&self.app, exchange_request(&code, Some(origin))).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["token"].as_str().unwrap().to_owned()
    }
}

/// The whole daemon router, so a bearer can be tried on every other route.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.plugins = crate::plugin_routes::PluginHost::at(
        Some(dir.path().join("plugins.json")),
        Arc::new(|_| None),
    );
    state.vault_drive = Some(Arc::new(crate::vault_drive::DriveStore::new(
        dir.path().join("drive"),
    )));
    Fixture {
        dir,
        app: crate::router(state),
    }
}

fn exchange_request(code: &str, origin: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/v1/plugins/pairing")
        .header("content-type", "application/json");
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    builder
        .body(Body::from(json!({ "code": code }).to_string()))
        .unwrap()
}

fn browser(
    method: &str,
    uri: &str,
    token: &str,
    origin: &str,
    body: Option<Value>,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("origin", origin)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap()
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value, HeaderMap) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body, headers)
}

fn allowed_origin(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn a_code_trades_once_for_a_bearer_that_opens_the_plugin_routes_from_its_origin() {
    let f = fixture();
    let code = f.code_for(PAGES);
    let (status, body, headers) = call(&f.app, exchange_request(&code, Some(PAGES))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["origin"], PAGES);
    assert_eq!(allowed_origin(&headers), Some(PAGES));
    let token = body["token"].as_str().unwrap();
    assert_ne!(token, code);
    for uri in ["/v1/plugins", "/v1/plugins/surrogate-proxy/notices"] {
        let (status, _, headers) = call(&f.app, browser("GET", uri, token, PAGES, None)).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(allowed_origin(&headers), Some(PAGES));
        assert!(headers.get_all(header::VARY).iter().any(|v| v == "Origin"));
        assert!(headers
            .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            .is_none());
    }
    let (again, body, _) = call(&f.app, exchange_request(&code, Some(PAGES))).await;
    assert_eq!(again, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "pairing_refused");
}

#[tokio::test]
async fn an_expired_code_is_refused() {
    let f = fixture();
    let issued_at = unix_now() - CODE_TTL_SECS - 1;
    let (code, _) = f.pairings().issue(PAGES, issued_at).unwrap();
    let (status, body, _) = call(&f.app, exchange_request(&code, Some(PAGES))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "pairing_refused");
}

#[tokio::test]
async fn a_code_from_the_wrong_origin_is_refused_and_spent() {
    let f = fixture();
    let code = f.code_for(PAGES);
    let (status, body, headers) = call(&f.app, exchange_request(&code, Some(OTHER))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "pairing_refused");
    assert_eq!(allowed_origin(&headers), None);
    let (status, _, _) = call(&f.app, exchange_request(&code, Some(PAGES))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a leaked code is dead");
    for origin in [
        None,
        Some("null"),
        Some("https://tyler-r-kendrick.github.io/"),
    ] {
        let code = f.code_for(PAGES);
        let (status, body, _) = call(&f.app, exchange_request(&code, origin)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin:?}");
        assert_eq!(body["error"], "origin_required");
    }
}

#[tokio::test]
async fn guessing_is_rate_limited() {
    let f = fixture();
    let mut statuses = Vec::new();
    for _ in 0..6 {
        let (status, _, _) = call(&f.app, exchange_request(&"A".repeat(43), Some(PAGES))).await;
        statuses.push(status);
    }
    assert!(statuses[..5].iter().all(|s| *s == StatusCode::FORBIDDEN));
    assert_eq!(statuses[5], StatusCode::TOO_MANY_REQUESTS);
    let code = f.code_for(PAGES);
    let (status, _, _) = call(&f.app, exchange_request(&code, Some(PAGES))).await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "even a real code waits"
    );
}

#[path = "plugin_pairing_scope_tests.rs"]
mod scope;
