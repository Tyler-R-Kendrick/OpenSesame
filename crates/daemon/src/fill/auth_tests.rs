//! Who may reach the fill routes: one test per caller that must be turned
//! away, and the pairing ceremony end to end.
use super::source::MemorySource;
use super::tests::{call, extension_headers, paired_app, request, EXT, TOKEN};
use super::*;
use opensesame_sealed_store::Entry;
use serde_json::Value;

const FILL: &str = "/v1/fill";

fn body() -> Value {
    json!({ "reference": "Web/example.com", "origin": "https://example.com", "field": "password" })
}

fn source() -> MemorySource {
    MemorySource {
        entries: vec![(
            "Web/example.com".into(),
            Entry {
                secret: "s3cret-value".into(),
                trailer: "url: https://example.com/\n".into(),
                otp: None,
            },
        )],
        locked: false,
    }
}

/// The extension's usual headers with `name` replaced (or dropped on `None`).
fn with(name: &str, value: Option<&str>) -> Vec<(&'static str, String)> {
    let mut headers: Vec<(&'static str, String)> = extension_headers()
        .into_iter()
        .filter(|(n, _)| *n != name)
        .collect();
    if let Some(value) = value {
        let name: &'static str = match name {
            "host" => "host",
            "origin" => "origin",
            "authorization" => "authorization",
            other => panic!("unexpected header {other}"),
        };
        headers.push((name, value.to_string()));
    }
    headers
}

async fn attempt(app: &Router, uri: &str, headers: &[(&str, String)]) -> (StatusCode, Value) {
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let (status, _, json) = call(app, request(uri, &body(), &borrowed)).await;
    (status, json)
}

#[tokio::test]
async fn a_missing_token_is_refused() {
    let app = paired_app(source());
    let (status, json) = attempt(&app, FILL, &with("authorization", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["error"], "pairing_token_required");
}

#[tokio::test]
async fn an_unpaired_token_is_refused() {
    let app = paired_app(source());
    let forged = format!("Bearer {}", "A".repeat(43));
    let (status, json) = attempt(&app, FILL, &with("authorization", Some(&forged))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["error"], "not_paired");
}

#[tokio::test]
async fn the_operator_token_is_not_a_pairing_token() {
    let app = paired_app(source());
    let operator = format!("Bearer {}", crate::test_operator_token());
    let (status, _) = attempt(&app, FILL, &with("authorization", Some(&operator))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_web_page_origin_is_refused() {
    let app = paired_app(source());
    for origin in ["https://example.com", "null", "http://127.0.0.1:18790"] {
        let (status, json) = attempt(&app, FILL, &with("origin", Some(origin))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
        assert_eq!(json["error"], "extension_origin_required");
    }
}

#[tokio::test]
async fn a_request_with_no_origin_is_refused() {
    let app = paired_app(source());
    let (status, _) = attempt(&app, FILL, &with("origin", None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn another_extensions_origin_with_the_token_is_refused() {
    let app = paired_app(source());
    let other = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
    let (status, json) = attempt(&app, FILL, &with("origin", Some(other))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["error"], "not_paired");
}

#[tokio::test]
async fn a_non_loopback_host_is_refused() {
    let app = paired_app(source());
    // A DNS-rebound name, the WSL bridge address, and a tailnet name.
    for host in [
        "evil.test:18790",
        "172.20.1.5:18790",
        "box.tail1234.ts.net",
        "",
    ] {
        let (status, json) = attempt(&app, FILL, &with("host", Some(host))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{host:?}");
        assert_eq!(json["error"], "loopback_only");
    }
    for host in ["localhost:18790", "[::1]:18790", "127.0.0.1"] {
        let (status, _) = attempt(&app, FILL, &with("host", Some(host))).await;
        assert_eq!(status, StatusCode::OK, "{host}");
    }
}

#[tokio::test]
async fn a_forwarded_request_is_refused() {
    let app = paired_app(source());
    let mut headers = extension_headers();
    headers.push(("x-forwarded-for", "100.64.0.9".into()));
    let (status, json) = attempt(&app, FILL, &headers).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(json["error"], "loopback_only");
}

#[tokio::test]
async fn the_ceremony_pairs_only_after_a_person_approves() {
    let state = Arc::new(FillState::new(
        Box::new(source()),
        None,
        Arc::new(gate::Fixed(true)),
    ));
    let app = {
        let st = crate::tests::test_state("http://127.0.0.1:1");
        routes(Arc::clone(&state), &st).with_state(st.clone())
    };
    // Before pairing, the token opens nothing.
    assert_eq!(
        attempt(&app, FILL, &extension_headers()).await.0,
        StatusCode::UNAUTHORIZED
    );

    let (status, pending) = attempt(&app, "/v1/fill/pair", &extension_headers()).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let code = pending["code"].as_str().unwrap().to_string();
    assert_eq!(
        attempt(&app, FILL, &extension_headers()).await.0,
        StatusCode::UNAUTHORIZED
    );

    // The extension cannot approve its own code: approve refuses an Origin.
    let mut own = extension_headers();
    own.push(("x-opensesame-operator", crate::test_operator_token().into()));
    let approve = json!({ "code": code });
    let borrowed: Vec<(&str, &str)> = own.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let (status, _, _) = call(&app, request("/v1/fill/pair/approve", &approve, &borrowed)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Nor can anyone without the operator credential.
    let (status, _, _) = call(&app, request("/v1/fill/pair/approve", &approve, &[])).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let operator = [("x-opensesame-operator", crate::test_operator_token())];
    let (status, _, json) = call(&app, request("/v1/fill/pair/approve", &approve, &operator)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json, json!({ "paired": true, "origin": EXT }));
    assert_eq!(
        attempt(&app, FILL, &extension_headers()).await.0,
        StatusCode::OK
    );
    let (status, json) = attempt(&app, "/v1/fill/pair", &extension_headers()).await;
    assert_eq!(
        (status, json),
        (StatusCode::OK, json!({ "state": "paired" }))
    );

    // The operator's list shows the origin and never the token or its digest.
    let list = axum::http::Request::builder()
        .uri("/v1/fill/pairings")
        .header("x-opensesame-operator", crate::test_operator_token())
        .body(axum::body::Body::empty())
        .unwrap();
    let (status, _, json) = call(&app, list).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["paired"][0]["origin"], EXT);
    assert!(!json.to_string().contains(TOKEN));

    // Revoked, the same token is dead again.
    let revoke = json!({ "origin": EXT });
    let (status, _, _) = call(&app, request("/v1/fill/pair/revoke", &revoke, &operator)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt(&app, FILL, &extension_headers()).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn an_unknown_code_approves_nothing() {
    let app = paired_app(source());
    let operator = [("x-opensesame-operator", crate::test_operator_token())];
    let approve = json!({ "code": "ZZZZ-ZZZZ" });
    let (status, _, json) = call(&app, request("/v1/fill/pair/approve", &approve, &operator)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json["error"], "unknown_code");
}

#[test]
fn a_callers_debug_never_prints_its_token() {
    let caller = caller::Caller {
        origin: EXT.into(),
        token: TOKEN.into(),
    };
    let printed = format!("{caller:?}");
    assert!(!printed.contains(TOKEN));
    assert!(printed.contains(EXT));
}

#[tokio::test]
async fn a_forger_claiming_the_extensions_origin_cannot_starve_the_real_extension() {
    let app = paired_app(source());
    // Any local process can send the extension's origin and a well-formed
    // token. Twenty times over, that must not touch the paired extension's
    // lookup budget.
    let forged = with("authorization", Some(&format!("Bearer {}", "B".repeat(43))));
    for _ in 0..20 {
        let (status, _) = attempt(&app, "/v1/fill/pair", &forged).await;
        assert!(
            matches!(status, StatusCode::ACCEPTED | StatusCode::TOO_MANY_REQUESTS),
            "{status}"
        );
    }
    let body = json!({ "origin": "https://example.com" });
    for _ in 0..5 {
        let headers = extension_headers();
        let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
        let (status, _, _) = call(&app, request("/v1/fill/match", &body, &borrowed)).await;
        assert_eq!(status, StatusCode::OK, "the real extension was throttled");
    }
}

#[tokio::test]
async fn forged_pair_requests_are_throttled_together_whatever_origin_they_claim() {
    let app = paired_app(source());
    let mut limited = 0;
    for n in 0..30 {
        let origin = format!(
            "chrome-extension://{}",
            char::from(b'a' + (n % 16)).to_string().repeat(32)
        );
        let mut headers = with("origin", Some(&origin));
        headers.retain(|(name, _)| *name != "authorization");
        headers.push(("authorization", format!("Bearer {}", "C".repeat(43))));
        let (status, _) = attempt(&app, "/v1/fill/pair", &headers).await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited += 1;
        }
    }
    assert!(
        limited > 0,
        "thirty distinct forged origins were never throttled"
    );
}
