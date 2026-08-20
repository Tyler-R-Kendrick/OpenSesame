//! Invoke-through route (ADR 0048 D6/D7): `POST /v1/invoke_through`.
//!
//! The daemon brokers one upstream call against a credential that stays on
//! this machine: preflight (egress allowlist, https, header/body caps) runs
//! first, the source tool is acquired *after* preflight on a blocking thread,
//! and the caller receives the upstream status, allowlisted headers, and
//! capped body — nothing else.
//!
//! Fences, in order:
//!
//! - **auth** — exactly `/v1/discover`'s: UDS peer-cred or TCP operator token.
//! - **rate limit** — its own bucket, separate from discover and promote.
//! - **confirmation** — v1 requires `confirmed: true` on every call. The
//!   promote handshake persists no per-connection invoke-through policy
//!   (D7 is stateless), so there is nothing that could relax the
//!   `per_invoke_confirmation` default; the refusal shape matches promote's
//!   (`400 …_not_confirmed`).
//! - **adapter** — a provider with no local credential tool is 422
//!   `no_invoke_through_adapter`.
//! - **preflight** — egress/allowlist denials map to 403/4xx *before* the
//!   source tool runs: a denied call never touches the credential.
//!
//! ## Receipt semantics
//!
//! The gateway's receipt surface (`routes/receipts.rs`) is read-only —
//! `GET /api/v1/receipts/{id}`, `…/verify`, `…/keys`; there is no POST ingest,
//! and the changelog record endpoint accepts only the frozen `secret.*` event
//! types. So in v1 there is no gateway-side route a daemon receipt could be
//! delivered to, and the "delivery failure must not fail the executed call"
//! question does not arise. Instead the daemon records the receipt **locally
//! and synchronously**: one structured `invoke_through.receipt` tracing event
//! (target `opensesame.receipt`) carrying provider, scheme+host+path — the
//! query string is dropped by the invoke-through crate because it may hold
//! secrets — status, latency, and the RFC 8693 subject/actor fields
//! (ADR 0049 §5), emitted before the response is returned. When a gateway
//! ingest route lands, this is the one call site to extend, and the delivery
//! failure rule will be: log and continue — the call has already executed.

use axum::{
    body::Bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use opensesame_invoke_through::{InvokeError, InvokeRequest};
use serde::Deserialize;
use serde_json::json;

use crate::{rate_limited, require_operator, App, RateKey, UdsPeer};

/// JSON envelope cap; the wire body itself is capped again inside the crate
/// (256 KiB) — this only bounds what the route will parse.
pub const MAX_BODY_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeThroughRequest {
    pub provider_id: String,
    pub method: String,
    pub url: String,
    /// Name/value pairs; the invoke-through crate enforces the allowlist
    /// (accept, content-type, user-agent).
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    /// v1: always required — see the module docs.
    #[serde(default)]
    pub confirmed: bool,
    /// RFC 8693 receipt placeholders (ADR 0049 §5).
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

/// `POST /v1/invoke_through` — broker one call through a local credential.
pub async fn invoke_through(
    State(st): State<App>,
    uds: UdsPeer,
    headers: HeaderMap,
    Json(req): Json<InvokeThroughRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let key = match uds.and_then(|Extension(ConnectInfo(info))| info.0) {
        Some(cred) => RateKey::Uid(cred.uid),
        None => RateKey::TcpOperator,
    };
    if let Err(retry_after) = st.invoke_limiter.check(key) {
        return rate_limited(retry_after);
    }
    if !req.confirmed {
        tracing::info!(provider_id = %req.provider_id, "invoke_through.refused");
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invoke_not_confirmed",
                "hint": "invoke-through exercises a local credential; \
                         pass confirmed: true (v1 requires per-invoke confirmation)"
            })),
        )
            .into_response();
    }
    let Some(source) = (st.token_source_factory)(&req.provider_id) else {
        tracing::info!(provider_id = %req.provider_id, "invoke_through.refused");
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "no_invoke_through_adapter",
                "hint": "no local credential tool for this provider in v1"
            })),
        )
            .into_response();
    };
    let prepared = match st.invoker.preflight(InvokeRequest {
        provider_id: req.provider_id.clone(),
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body.map(Bytes::from),
        subject: req.subject,
        actor: req.actor,
    }) {
        Ok(prepared) => prepared,
        Err(error) => {
            tracing::info!(provider_id = %req.provider_id, reason = %error, "invoke_through.refused");
            return preflight_error(error);
        }
    };
    // Preflight passed; only now may the source tool run. It blocks (a child
    // process), so it runs off the async driver threads.
    let token = match tokio::task::spawn_blocking(move || source.acquire()).await {
        Ok(Ok(token)) => token,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "invoke_through token acquisition failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": "token_source_failed"})),
            )
                .into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match st.invoker.execute(&token, prepared).await {
        Ok(upstream) => {
            // The local, synchronous receipt — see the module docs for why
            // there is no gateway delivery in v1.
            let receipt = &upstream.receipt;
            tracing::info!(
                target: "opensesame.receipt",
                provider_id = %receipt.provider_id,
                scheme = %receipt.scheme,
                host = %receipt.host,
                path = %receipt.path,
                status = receipt.status,
                latency_ms = receipt.latency_ms,
                subject = receipt.subject.as_deref().unwrap_or(""),
                actor = receipt.actor.as_deref().unwrap_or(""),
                "invoke_through.receipt"
            );
            // The caller gets the upstream response: status, allowlisted
            // headers, body — and nothing else.
            let mut response = Response::builder()
                .status(StatusCode::from_u16(upstream.status).unwrap_or(StatusCode::BAD_GATEWAY));
            for (name, value) in &upstream.headers {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    response = response.header(name, value);
                }
            }
            response
                .body(axum::body::Body::from(upstream.body))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(error) => execute_error(error),
    }
}

/// Preflight denials are client-visible and precise: the caller named the
/// host/method/header, so learning why it was refused tells them nothing new.
fn preflight_error(error: InvokeError) -> Response {
    let (status, code) = match &error {
        InvokeError::InvalidUrl => (StatusCode::BAD_REQUEST, "invalid_url"),
        InvokeError::UnsupportedProvider(_) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "no_invoke_through_adapter",
        ),
        InvokeError::EgressDenied { .. } => (StatusCode::FORBIDDEN, "egress_denied"),
        InvokeError::HttpsRequired(_) => (StatusCode::BAD_REQUEST, "https_required"),
        InvokeError::MethodNotAllowed(_) => (StatusCode::BAD_REQUEST, "method_not_allowed"),
        InvokeError::HeaderNotAllowed(_) => (StatusCode::BAD_REQUEST, "header_not_allowed"),
        InvokeError::RequestBodyTooLarge { .. } => {
            (StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large")
        }
        _ => (StatusCode::BAD_REQUEST, "invalid_request"),
    };
    (
        status,
        Json(json!({"error": code, "hint": error.to_string()})),
    )
        .into_response()
}

/// Execution failures are upstream or acquisition problems; the hint never
/// carries the credential (the crate's error contract) and the transport
/// detail names at most the host, which the receipt would record anyway.
fn execute_error(error: InvokeError) -> Response {
    let (status, code) = match &error {
        InvokeError::Timeout => (StatusCode::GATEWAY_TIMEOUT, "upstream_timeout"),
        InvokeError::ResponseTooLarge { .. } => (StatusCode::BAD_GATEWAY, "response_too_large"),
        InvokeError::Transport(_) => (StatusCode::BAD_GATEWAY, "upstream_unreachable"),
        InvokeError::TokenUnavailable(_) | InvokeError::MalformedToken => {
            (StatusCode::BAD_GATEWAY, "token_source_failed")
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "invoke_failed"),
    };
    (
        status,
        Json(json!({"error": code, "hint": error.to_string()})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{router, tests::test_state};
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use opensesame_invoke_through::{AuthStyle, EgressRule, Invoker, TokenSource};
    use secrecy::SecretString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const CANARY: &str = "CANARY-TOKEN-never-in-response-surfaces";
    const OPERATOR: &str = "opensesame-dev-operator";

    struct CanarySource;

    impl TokenSource for CanarySource {
        fn acquire(&self) -> Result<SecretString, InvokeError> {
            Ok(SecretString::from(CANARY))
        }
    }

    /// A source that records whether it ran, so egress-denial tests can prove
    /// acquisition never happened.
    struct GatedSource(Arc<AtomicBool>);

    impl TokenSource for GatedSource {
        fn acquire(&self) -> Result<SecretString, InvokeError> {
            self.0.store(true, Ordering::SeqCst);
            Ok(SecretString::from(CANARY))
        }
    }

    struct FailingSource;

    impl TokenSource for FailingSource {
        fn acquire(&self) -> Result<SecretString, InvokeError> {
            Err(InvokeError::TokenUnavailable(
                "gh exited with exit status: 1".into(),
            ))
        }
    }

    fn loopback_rule() -> EgressRule {
        EgressRule {
            provider_id: "github",
            scheme: "https",
            hosts: &["127.0.0.1"],
            auth: AuthStyle::Bearer,
        }
    }

    fn state_with(invoker: Invoker, factory: crate::TokenSourceFactory) -> App {
        let mut st = test_state("http://127.0.0.1:1");
        st.invoker = Arc::new(invoker);
        st.token_source_factory = factory;
        st
    }

    fn canary_state(invoker: Invoker) -> App {
        state_with(invoker, Arc::new(|_| Some(Box::new(CanarySource))))
    }

    fn request(body: &str, with_token: bool) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/v1/invoke_through")
            .header("content-type", "application/json");
        if with_token {
            builder = builder.header("x-opensesame-operator", OPERATOR);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    fn invoke_body(url: &str, confirmed: bool) -> String {
        format!(
            r#"{{"provider_id":"github","method":"GET","url":"{url}","confirmed":{confirmed},"subject":"user:alice","actor":"agent:test"}}"#
        )
    }

    /// Loopback upstream stub recording (path, authorization) per hit.
    type Hits = Arc<Mutex<Vec<(String, Option<String>)>>>;

    async fn spawn_upstream() -> (String, Hits) {
        #[derive(Clone)]
        struct Stub {
            hits: Hits,
        }
        let hits = Arc::new(Mutex::new(Vec::new()));
        let stub = Stub { hits: hits.clone() };
        let app = axum::Router::new()
            .route(
                "/zen",
                axum::routing::get(|State(stub): State<Stub>, headers: HeaderMap| async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    stub.hits.lock().unwrap().push(("/zen".to_string(), auth));
                    (
                        StatusCode::OK,
                        [
                            ("content-type", "application/json"),
                            ("set-cookie", "session=dropped"),
                        ],
                        r#"{"zen":"ok"}"#,
                    )
                }),
            )
            .route(
                "/redirect",
                axum::routing::get(|State(stub): State<Stub>| async move {
                    stub.hits
                        .lock()
                        .unwrap()
                        .push(("/redirect".to_string(), None));
                    (StatusCode::FOUND, [("location", "/target")], "see /target")
                }),
            )
            .route(
                "/target",
                axum::routing::get(|State(stub): State<Stub>| async move {
                    stub.hits
                        .lock()
                        .unwrap()
                        .push(("/target".to_string(), None));
                    "followed!"
                }),
            )
            .with_state(stub);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://127.0.0.1:{}", addr.port()), hits)
    }

    #[tokio::test]
    async fn unauthenticated_callers_are_refused() {
        let app = router(test_state("http://127.0.0.1:1"));
        let res = app
            .oneshot(request(
                &invoke_body("https://api.github.com/zen", true),
                false,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn confirmation_is_required() {
        let app = router(test_state("http://127.0.0.1:1"));
        let res = app
            .oneshot(request(
                &invoke_body("https://api.github.com/zen", false),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "invoke_not_confirmed");
    }

    #[tokio::test]
    async fn invoke_through_spends_from_its_own_bucket() {
        let app = router(test_state("http://127.0.0.1:1"));
        let first = app
            .clone()
            .oneshot(request(
                &invoke_body("https://api.github.com/zen", false),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::BAD_REQUEST);
        let second = app
            .oneshot(request(
                &invoke_body("https://api.github.com/zen", false),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn egress_denial_precedes_connection_and_acquisition() {
        let (base, hits) = spawn_upstream().await;
        let acquired = Arc::new(AtomicBool::new(false));
        let gated = acquired.clone();
        // Production-rule invoker: only api.github.com/uploads.github.com,
        // https only — the loopback stub fails the allowlist.
        let st = state_with(
            Invoker::new(),
            Arc::new(move |_| {
                Some(Box::new(GatedSource(gated.clone()))
                    as Box<dyn opensesame_invoke_through::TokenSource>)
            }),
        );
        let app = router(st);
        let res = app
            .oneshot(request(&invoke_body(&format!("{base}/zen"), true), true))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "egress_denied");
        assert!(hits.lock().unwrap().is_empty(), "upstream was contacted");
        assert!(
            !acquired.load(Ordering::SeqCst),
            "the source tool ran for a denied call"
        );
    }

    #[tokio::test]
    async fn happy_path_returns_the_upstream_response_only() {
        let (base, hits) = spawn_upstream().await;
        let app = router(canary_state(
            Invoker::with_rules(vec![loopback_rule()]).allow_http_for_tests(),
        ));
        let res = app
            .oneshot(request(
                &invoke_body(&format!("{base}/zen?access_token=QUERY-SECRET"), true),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get("set-cookie").is_none());
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert_eq!(text, r#"{"zen":"ok"}"#);
        assert!(!text.contains(CANARY));
        assert!(!text.contains("QUERY-SECRET"));
        let hits = hits.lock().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].1.as_deref(),
            Some(format!("Bearer {CANARY}").as_str())
        );
    }

    #[tokio::test]
    async fn redirects_are_not_followed_through_the_route() {
        let (base, hits) = spawn_upstream().await;
        let app = router(canary_state(
            Invoker::with_rules(vec![loopback_rule()]).allow_http_for_tests(),
        ));
        let res = app
            .oneshot(request(
                &invoke_body(&format!("{base}/redirect"), true),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        assert_eq!(body.as_ref(), b"see /target");
        assert_eq!(hits.lock().unwrap().len(), 1, "the redirect was chased");
    }

    #[tokio::test]
    async fn a_provider_without_an_adapter_is_422() {
        let app = router(test_state("http://127.0.0.1:1"));
        let res = app
            .oneshot(request(
                &invoke_body("https://api.github.com/zen", true),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "no_invoke_through_adapter");
    }

    #[tokio::test]
    async fn acquisition_failure_is_502_without_secret_detail() {
        let st = state_with(Invoker::new(), Arc::new(|_| Some(Box::new(FailingSource))));
        let app = router(st);
        let res = app
            .oneshot(request(
                &invoke_body("https://api.github.com/zen", true),
                true,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        let body = to_bytes(res.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "token_source_failed");
        assert!(!json.to_string().contains(CANARY));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invoke_through_honors_uds_peer_attestation() {
        use crate::peer_auth::UdsConnectInfo;
        use axum::extract::ConnectInfo;

        let st = test_state("http://127.0.0.1:1");
        let own = st.allowed_uids[0];
        let app = router(st);
        let build = |uid: Option<u32>| {
            let mut req = request(&invoke_body("https://api.github.com/zen", false), false);
            let cred = uid.map(|uid| opensesame_uds_authn::PeerCred {
                pid: 4242,
                uid,
                gid: uid,
            });
            req.extensions_mut()
                .insert(ConnectInfo(UdsConnectInfo(cred)));
            req
        };
        // Attested same-uid caller passes auth and reaches the confirm gate.
        let res = app.clone().oneshot(build(Some(own))).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let res = app.oneshot(build(Some(own + 1))).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
