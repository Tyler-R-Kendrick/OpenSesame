//! Unit tests for the invoke-through executor, kept beside `invoke.rs` so the
//! executor itself stays inside the module-size budget (ADR 0093).

use super::stub::spawn_stub;
use super::*;
use crate::egress::AuthStyle;

const CANARY: &str = "CANARY-TOKEN-7f3d9b-never-leaks";

fn test_rule(hosts: &'static [&'static str]) -> EgressRule {
    EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts,
        auth: AuthStyle::Bearer,
    }
}

fn test_invoker(hosts: &'static [&'static str]) -> Invoker {
    Invoker::with_rules(vec![test_rule(hosts)]).allow_http_for_tests()
}

fn request(url: String) -> InvokeRequest {
    InvokeRequest {
        provider_id: "github".into(),
        method: "GET".into(),
        url,
        headers: vec![],
        body: None,
        subject: Some("user:alice".into()),
        actor: Some("agent:test".into()),
    }
}

fn canary() -> SecretString {
    SecretString::from(CANARY)
}

#[tokio::test]
async fn egress_denial_happens_before_any_connection() {
    let (base, recorded) = spawn_stub(|_| (200, vec![], "ok")).await;
    // The loopback stub is live and would answer, but 127.0.0.1 is not on
    // the github allowlist — the call must die in preflight.
    let invoker = Invoker::with_rules(vec![test_rule(&["api.github.com"])]);
    let err = invoker
        .preflight(request(base))
        .expect_err("loopback host is not allowlisted");
    assert!(matches!(err, InvokeError::EgressDenied { .. }));
    assert!(
        recorded.lock().unwrap().hits.is_empty(),
        "the stub must never be hit"
    );
}

#[tokio::test]
async fn non_default_ports_off_loopback_are_denied() {
    let invoker = Invoker::with_rules(vec![test_rule(&["api.github.com"])]);
    let err = invoker
        .preflight(request("https://api.github.com:8443/zen".into()))
        .expect_err("non-default port");
    assert!(matches!(err, InvokeError::EgressDenied { .. }));
}

#[tokio::test]
async fn userinfo_urls_are_refused() {
    let invoker = test_invoker(&["127.0.0.1"]);
    let err = invoker
        .preflight(request("http://user:pw@127.0.0.1:1/zen".into()))
        .expect_err("userinfo");
    assert!(matches!(err, InvokeError::InvalidUrl));
}

#[tokio::test]
async fn https_is_required_outside_test_mode() {
    let invoker = Invoker::with_rules(vec![test_rule(&["127.0.0.1"])]);
    let err = invoker
        .preflight(request("http://127.0.0.1:9/zen".into()))
        .expect_err("http without the test flag");
    assert!(matches!(err, InvokeError::HttpsRequired(_)));
}

#[tokio::test]
async fn happy_path_sends_bearer_and_returns_the_upstream_response() {
    let (base, recorded) = spawn_stub(|_| {
        (
            200,
            vec![
                ("content-type", "application/json"),
                ("etag", "\"abc\""),
                ("set-cookie", "session=dropped"),
                ("x-secret-upstream", "dropped"),
            ],
            "{\"zen\":\"ok\"}",
        )
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker
                .preflight(request(format!("{base}/zen?access_token=QUERY-SECRET")))
                .unwrap(),
        )
        .await
        .expect("invoked");
    // The token reached the allowlisted host, exactly once, as a bearer.
    let hits = recorded.lock().unwrap();
    assert_eq!(hits.hits.len(), 1);
    assert_eq!(hits.hits[0].0, "/zen");
    assert_eq!(
        hits.hits[0].1.as_deref(),
        Some(format!("Bearer {CANARY}").as_str())
    );
    drop(hits);
    assert_eq!(response.status, 200);
    assert_eq!(response.body.as_ref(), b"{\"zen\":\"ok\"}");
    // Allowlisted response headers survive; everything else is dropped.
    assert!(response.headers.iter().any(|(n, _)| n == "etag"));
    assert!(response.headers.iter().any(|(n, _)| n == "content-type"));
    assert!(!response.headers.iter().any(|(n, _)| n == "set-cookie"));
    assert!(!response
        .headers
        .iter()
        .any(|(n, _)| n == "x-secret-upstream"));
    // Receipt: scheme+host+path, never the query; subject/actor echo.
    assert_eq!(response.receipt.scheme, "http");
    assert_eq!(response.receipt.host, "127.0.0.1");
    assert_eq!(response.receipt.path, "/zen");
    assert_eq!(response.receipt.subject.as_deref(), Some("user:alice"));
    assert_eq!(response.receipt.actor.as_deref(), Some("agent:test"));
    let receipt_json = serde_json::to_string(&response.receipt).unwrap();
    assert!(!receipt_json.contains("QUERY-SECRET"));
    assert!(!receipt_json.contains(CANARY));
}

#[tokio::test]
async fn redirects_are_returned_never_followed() {
    let (base, recorded) = spawn_stub(|req| {
        if req.uri().path() == "/redirect" {
            (302, vec![("content-type", "text/plain")], "see /target")
        } else {
            (200, vec![], "followed!")
        }
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker
                .preflight(request(format!("{base}/redirect")))
                .unwrap(),
        )
        .await
        .expect("invoked");
    assert_eq!(response.status, 302);
    assert_eq!(response.body.as_ref(), b"see /target");
    let hits = recorded.lock().unwrap();
    assert_eq!(hits.hits.len(), 1, "the redirect target was chased");
    assert_eq!(hits.hits[0].0, "/redirect");
}

#[tokio::test]
async fn the_token_never_appears_in_error_surfaces() {
    // Transport failure (connection refused on a dead port) must describe
    // the failure class, never the credential.
    let invoker = test_invoker(&["127.0.0.1"]);
    let err = invoker
        .execute(
            &canary(),
            invoker
                .preflight(request("http://127.0.0.1:1/zen".into()))
                .unwrap(),
        )
        .await
        .expect_err("dead port");
    let rendered = format!("{err} / {err:?}");
    assert!(!rendered.contains(CANARY), "{rendered}");

    // A token that cannot be a header value errors without quoting it.
    let bad = SecretString::from("line1\nline2");
    let err = invoker
        .execute(
            &bad,
            invoker
                .preflight(request("http://127.0.0.1:1/zen".into()))
                .unwrap(),
        )
        .await
        .expect_err("malformed token");
    assert!(matches!(err, InvokeError::MalformedToken));
    assert!(!format!("{err} / {err:?}").contains("line1"));
}

#[tokio::test]
async fn request_body_cap_bites_before_connecting() {
    let (base, recorded) = spawn_stub(|_| (200, vec![], "ok")).await;
    let invoker = test_invoker(&["127.0.0.1"]).with_caps(16, DEFAULT_RESPONSE_BODY_CAP);
    let mut req = request(format!("{base}/zen"));
    req.method = "POST".into();
    req.body = Some(Bytes::from(vec![b'x'; 32]));
    let err = invoker.preflight(req).expect_err("oversized body");
    assert!(matches!(err, InvokeError::RequestBodyTooLarge { .. }));
    assert!(recorded.lock().unwrap().hits.is_empty());
}

#[tokio::test]
async fn response_body_is_capped() {
    let (base, _) = spawn_stub(|_| {
        (
            200,
            vec![("content-type", "text/plain")],
            "this body is far longer than sixteen bytes",
        )
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]).with_caps(DEFAULT_REQUEST_BODY_CAP, 16);
    let err = invoker
        .execute(&canary(), invoker.preflight(request(base)).unwrap())
        .await
        .expect_err("oversized response");
    assert!(matches!(err, InvokeError::ResponseTooLarge { .. }));
    let rendered = format!("{err} / {err:?}");
    assert!(!rendered.contains(CANARY));
}

#[tokio::test]
async fn caller_headers_are_allowlisted() {
    let invoker = test_invoker(&["127.0.0.1"]);
    for banned in [
        "authorization",
        "cookie",
        "x-api-key",
        "proxy-authorization",
    ] {
        let mut req = request("http://127.0.0.1:1/zen".into());
        req.headers = vec![(banned.into(), "planted".into())];
        let err = invoker.preflight(req).expect_err("banned header");
        assert!(matches!(err, InvokeError::HeaderNotAllowed(_)), "{banned}");
    }
    let mut req = request("http://127.0.0.1:1/zen".into());
    req.headers = vec![
        ("Accept".into(), "application/vnd.github+json".into()),
        ("content-type".into(), "application/json".into()),
        ("USER-AGENT".into(), "my-agent".into()),
    ];
    invoker.preflight(req).expect("allowlisted headers pass");
}

#[tokio::test]
async fn unknown_methods_and_providers_are_refused() {
    let invoker = test_invoker(&["127.0.0.1"]);
    let mut req = request("http://127.0.0.1:1/zen".into());
    req.method = "TRACE".into();
    assert!(matches!(
        invoker.preflight(req).expect_err("trace"),
        InvokeError::MethodNotAllowed(_)
    ));
    let mut req = request("http://127.0.0.1:1/zen".into());
    req.provider_id = "aws".into();
    assert!(matches!(
        invoker.preflight(req).expect_err("aws in v1"),
        InvokeError::UnsupportedProvider(_)
    ));
}

struct StubSource;

impl TokenSource for StubSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        Ok(canary())
    }
}

#[tokio::test]
async fn execute_with_source_acquires_after_preflight() {
    let invoker = Invoker::with_rules(vec![test_rule(&["api.github.com"])]);
    let err = invoker
        .execute_with_source(&StubSource, request("http://127.0.0.1:1/zen".into()))
        .await
        .expect_err("denied in preflight");
    assert!(matches!(err, InvokeError::EgressDenied { .. }));
}

/// An upstream that reflects the presented credential — an echo/debug route,
/// or an error that quotes the bad token — must not become an oracle: the
/// caller gets the response, never the credential inside it. Raw, base64 at
/// every alignment (a reflected `Basic` blob), and percent-encoded forms.
#[tokio::test]
async fn a_reflected_credential_never_reaches_the_caller() {
    const REFLECTED: &str = concat!(
        "{\"echo\":\"Bearer CANARY-TOKEN-7f3d9b-never-leaks\",",
        // base64("x:" + CANARY) — the token at alignment 2 inside a blob.
        "\"basic\":\"eDpDQU5BUlktVE9LRU4tN2YzZDliLW5ldmVyLWxlYWtz\",",
        // base64(CANARY) — alignment 0.
        "\"b64\":\"Q0FOQVJZLVRPS0VOLTdmM2Q5Yi1uZXZlci1sZWFrcw==\"}"
    );
    let (base, _recorded) = spawn_stub(|_| {
        (
            401,
            vec![
                ("content-type", "application/json"),
                ("x-github-request-id", "CANARY-TOKEN-7f3d9b-never-leaks"),
            ],
            REFLECTED,
        )
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker.preflight(request(format!("{base}/echo"))).unwrap(),
        )
        .await
        .expect("a 401 is a response, not an error");
    let body = String::from_utf8(response.body.to_vec()).unwrap();
    assert_eq!(response.status, 401);
    assert!(!body.contains(CANARY), "{body}");
    assert!(!body.contains("VE9LRU4tN2YzZDliLW5ldmVyLWxlYWtz"), "{body}");
    assert!(
        !body.contains("LVRPS0VOLTdmM2Q5Yi1uZXZlci1sZWFrc"),
        "{body}"
    );
    assert!(body.contains("[redacted:credential]"), "{body}");
    let headers = format!("{:?}", response.headers);
    assert!(!headers.contains(CANARY), "{headers}");
    assert!(response.receipt.credential_reflected);
    let receipt = serde_json::to_string(&response.receipt).unwrap();
    assert!(
        receipt.contains("\"credential_reflected\":true"),
        "{receipt}"
    );
}

/// A response that never mentions the credential passes byte-for-byte, and
/// the receipt does not claim a reflection that did not happen.
#[tokio::test]
async fn an_unreflecting_response_is_returned_unchanged() {
    let (base, _recorded) = spawn_stub(|_| (200, vec![], "{\"zen\":\"Q0FOQVJZ\"}")).await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker.preflight(request(format!("{base}/zen"))).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(&response.body[..], b"{\"zen\":\"Q0FOQVJZ\"}");
    assert!(!response.receipt.credential_reflected);
    let receipt = serde_json::to_string(&response.receipt).unwrap();
    assert!(!receipt.contains("credential_reflected"), "{receipt}");
}
