//! Route tests: one per way a caller could be handed a value it should not.
use super::source::MemorySource;
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use opensesame_sealed_store::Entry;
use serde_json::Value;
use tower::ServiceExt;

pub(super) const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
pub(super) const TOKEN: &str = "k7Q2mB9xR4tW8vN1cZ6yH3jL5pS0aD7fG2eU9iO4qT1";
const SECRET: &str = "correct-horse-battery-staple";

fn entry(secret: &str, trailer: &str) -> Entry {
    Entry {
        secret: secret.into(),
        trailer: trailer.into(),
        otp: None,
    }
}

pub(super) fn store() -> MemorySource {
    MemorySource {
        entries: vec![
            (
                "Web/example.com".into(),
                entry(SECRET, "login: alice\nurl: https://example.com/login\n"),
            ),
            (
                "Web/other.test".into(),
                entry("other-secret", "url: https://other.test/\n"),
            ),
            ("Dev/no-url".into(), entry("no-url-secret", "")),
        ],
        locked: false,
    }
}

/// A router over `source` with `EXT` already paired to `TOKEN`.
pub(super) fn paired_app(source: MemorySource) -> Router {
    paired_app_behind(source, Arc::new(gate::Fixed(true)))
}

/// The same, behind a given plugin switch.
pub(super) fn paired_app_behind(source: MemorySource, gate: Arc<dyn gate::PluginGate>) -> Router {
    let state = Arc::new(FillState::new(Box::new(source), None, gate));
    let now = chrono::Utc::now();
    let PairOutcome::Pending { code, .. } = state.pairings.request(EXT, TOKEN, now) else {
        panic!("pairing request");
    };
    state.pairings.approve(&code, now).unwrap();
    let st = crate::tests::test_state("http://127.0.0.1:1");
    routes(state, &st).with_state(st.clone())
}

pub(super) fn request(uri: &str, body: &Value, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

pub(super) fn extension_headers() -> Vec<(&'static str, String)> {
    vec![
        ("host", "127.0.0.1:18790".into()),
        ("origin", EXT.into()),
        ("authorization", format!("Bearer {TOKEN}")),
    ]
}

pub(super) async fn call(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Value) {
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

pub(super) async fn fill(
    app: &Router,
    reference: &str,
    origin: &str,
    field: &str,
) -> (StatusCode, Value) {
    let headers = extension_headers();
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let body = json!({ "reference": reference, "origin": origin, "field": field });
    let (status, _, json) = call(app, request("/v1/fill", &body, &borrowed)).await;
    (status, json)
}

#[tokio::test]
async fn the_exact_origin_gets_one_field() {
    let app = paired_app(store());
    let (status, json) = fill(&app, "Web/example.com", "https://example.com", "password").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json, json!({ "field": "password", "value": SECRET }));
    let (_, json) = fill(&app, "Web/example.com", "https://example.com", "username").await;
    assert_eq!(json, json!({ "field": "username", "value": "alice" }));
}

#[tokio::test]
async fn a_value_is_never_cached() {
    let app = paired_app(store());
    let headers = extension_headers();
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let body = json!({ "reference": "Web/example.com", "origin": "https://example.com", "field": "password" });
    let (_, headers, _) = call(&app, request("/v1/fill", &body, &borrowed)).await;
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn a_lookalike_origin_is_refused() {
    let app = paired_app(store());
    for origin in ["https://example.com.evil.test", "https://evilexample.com"] {
        let (status, json) = fill(&app, "Web/example.com", origin, "password").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{origin}");
        assert_eq!(json, json!({ "error": "no_match" }));
    }
}

#[tokio::test]
async fn a_subdomain_is_refused() {
    let app = paired_app(store());
    let (status, _) = fill(
        &app,
        "Web/example.com",
        "https://login.example.com",
        "password",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn another_port_is_refused() {
    let app = paired_app(store());
    let (status, _) = fill(
        &app,
        "Web/example.com",
        "https://example.com:8443",
        "password",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn another_scheme_is_refused() {
    let app = paired_app(store());
    let (status, _) = fill(&app, "Web/example.com", "http://example.com", "password").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn another_sites_entry_reads_exactly_like_a_missing_one() {
    let app = paired_app(store());
    let other = fill(&app, "Web/other.test", "https://example.com", "password").await;
    let missing = fill(&app, "Web/nope", "https://example.com", "password").await;
    let no_url = fill(&app, "Dev/no-url", "https://example.com", "password").await;
    assert_eq!(other, missing);
    assert_eq!(no_url, missing);
}

#[tokio::test]
async fn a_non_canonical_origin_or_reference_is_refused() {
    let app = paired_app(store());
    let (status, _) = fill(&app, "Web/example.com", "https://example.com/", "password").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = fill(
        &app,
        "Web/../Web/example.com",
        "https://example.com",
        "password",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = fill(&app, "Web/example.com", "https://example.com", "otp").await;
    assert!(status.is_client_error(), "only password or username");
}

#[tokio::test]
async fn match_names_entries_and_never_values() {
    let app = paired_app(store());
    let headers = extension_headers();
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let body = json!({ "origin": "https://example.com" });
    let (status, headers, json) = call(&app, request("/v1/fill/match", &body, &borrowed)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        json!({ "references": ["Web/example.com"], "truncated": false })
    );
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(!json.to_string().contains(SECRET));
}

#[tokio::test]
async fn a_locked_store_says_so_and_nothing_else() {
    let app = paired_app(MemorySource {
        entries: Vec::new(),
        locked: true,
    });
    let (status, json) = fill(&app, "Web/example.com", "https://example.com", "password").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json, json!({ "error": "store_locked" }));
}

#[tokio::test]
async fn fills_are_rate_limited_per_extension() {
    let app = paired_app(store());
    let mut last = StatusCode::OK;
    for _ in 0..6 {
        last = fill(&app, "Web/example.com", "https://example.com", "password")
            .await
            .0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    let headers = extension_headers();
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let body = json!({ "reference": "Web/example.com", "origin": "https://example.com", "field": "password" });
    let (_, headers, json) = call(&app, request("/v1/fill", &body, &borrowed)).await;
    assert_eq!(json["error"], "rate_limited");
    assert!(headers.contains_key(header::RETRY_AFTER));
}
