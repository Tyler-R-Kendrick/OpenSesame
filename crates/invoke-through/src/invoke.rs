//! The invoke-through executor (ADR 0048 D6/D7, I8).
//!
//! Call sequence: [`Invoker::preflight`] validates the request against the
//! egress allowlist **before any credential is touched and before any
//! connection is attempted**; the caller then acquires a token (on a blocking
//! thread — source tools are child processes) and hands it to
//! [`Invoker::execute`]. The token enters exactly one
//! `Authorization: Bearer` header, marked sensitive, and is dropped with the
//! request. Redirects are never followed: hyper follows none by default and a
//! 3xx is returned to the caller like any other status — a credential must
//! never be chased onto a host the allowlist did not name.
//!
//! The wire client is hyper over rustls with **webpki roots only** (no native
//! cert store, no reqwest, no cookie store — the ADR 0048 D5 budget).

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Method, Uri};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::egress::{rule_for, EgressRule, EGRESS_RULES};
use crate::error::InvokeError;
use crate::source::TokenSource;

/// Outbound body cap: generous for an API payload, useless for exfiltration.
pub const DEFAULT_REQUEST_BODY_CAP: usize = 256 * 1024;
/// Inbound body cap (ADR 0048 D7: the upstream response only, capped).
pub const DEFAULT_RESPONSE_BODY_CAP: usize = 1024 * 1024;
/// Whole-call timeout, connect through last body byte.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// Request headers a caller may set. `authorization` is absent on purpose:
/// the token is the daemon's to place, never the caller's.
const REQUEST_HEADER_ALLOWLIST: &[&str] = &["accept", "content-type", "user-agent"];

/// Response headers passed back to the caller. Everything else upstream sent
/// is dropped here — `set-cookie` above all.
const RESPONSE_HEADER_ALLOWLIST: &[&str] = &[
    "content-type",
    "etag",
    "cache-control",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-github-request-id",
];

const DEFAULT_USER_AGENT: &str = concat!("opensesame-invoke-through/", env!("CARGO_PKG_VERSION"));

type HttpsClient = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

/// One validated invoke-through call.
pub struct InvokeRequest {
    pub provider_id: String,
    pub method: String,
    pub url: String,
    /// Name/value pairs; names must be on [`REQUEST_HEADER_ALLOWLIST`].
    pub headers: Vec<(String, String)>,
    pub body: Option<Bytes>,
    /// RFC 8693 placeholders carried into the receipt (ADR 0049 §5). The
    /// daemon fills them; this crate only echoes them through.
    pub subject: Option<String>,
    pub actor: Option<String>,
}

/// What the caller gets back: the upstream response and nothing else.
/// Contains no credential material by construction — Debug is safe.
#[derive(Debug)]
pub struct InvokeResponse {
    pub status: u16,
    /// Allowlisted response headers only.
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    pub receipt: ReceiptMeta,
}

/// Structured receipt metadata for one brokered call (ADR 0049 §5).
///
/// `path` is the URL path **only** — query strings may carry secrets
/// (presigned URLs, `?access_token=`) and are never recorded. Serialize this
/// freely: by construction it cannot contain the credential.
#[derive(Debug, Clone, Serialize)]
pub struct ReceiptMeta {
    pub provider_id: String,
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub status: u16,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
}

/// A request that has passed every pre-connect fence. Constructing one is
/// proof the egress allowlist, scheme, method, header allowlist, and body cap
/// all checked out. Carries no credential — the token is added in
/// [`Invoker::execute`] and dies with the wire request.
#[derive(Debug)]
pub struct PreparedRequest {
    provider_id: String,
    method: Method,
    uri: Uri,
    scheme: String,
    host: String,
    path: String,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Bytes,
    subject: Option<String>,
    actor: Option<String>,
}

/// The broker. Cheap to build; the daemon holds one in shared state.
pub struct Invoker {
    client: HttpsClient,
    rules: Arc<Vec<EgressRule>>,
    /// Loopback-only HTTP for tests. Never set in production construction.
    allow_http_for_tests: bool,
    request_body_cap: usize,
    response_body_cap: usize,
    timeout: Duration,
}

impl Default for Invoker {
    fn default() -> Self {
        Self::new()
    }
}

impl Invoker {
    /// Production broker: the static catalog-derived allowlist, https only.
    pub fn new() -> Self {
        Self::with_rules(EGRESS_RULES.to_vec())
    }

    /// Broker over an explicit rule set. Still https only — see
    /// [`Invoker::allow_http_for_tests`].
    pub fn with_rules(rules: Vec<EgressRule>) -> Self {
        Self {
            client: build_client(),
            rules: Arc::new(rules),
            allow_http_for_tests: false,
            request_body_cap: DEFAULT_REQUEST_BODY_CAP,
            response_body_cap: DEFAULT_RESPONSE_BODY_CAP,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// Permit plain HTTP **to loopback hosts only**, for in-process test
    /// stubs. The egress allowlist still applies; this relaxes the scheme
    /// check alone, and only for 127.0.0.1 / ::1 / localhost.
    pub fn allow_http_for_tests(mut self) -> Self {
        self.allow_http_for_tests = true;
        self
    }

    /// Override the body caps (tests exercise them with small values).
    pub fn with_caps(mut self, request_body_cap: usize, response_body_cap: usize) -> Self {
        self.request_body_cap = request_body_cap;
        self.response_body_cap = response_body_cap;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Validate every fence that must hold before a credential is touched or
    /// a socket is opened: provider adapter, egress allowlist (exact host
    /// match), https, method, header allowlist, body cap.
    pub fn preflight(&self, req: InvokeRequest) -> Result<PreparedRequest, InvokeError> {
        let method = parse_method(&req.method)?;
        let uri: Uri = req.url.parse().map_err(|_| InvokeError::InvalidUrl)?;
        let authority = uri.authority().ok_or(InvokeError::InvalidUrl)?;
        // Userinfo must never be honored: it is a credential embedded in a
        // string that receipts and errors legitimately name.
        if authority.as_str().contains('@') {
            return Err(InvokeError::InvalidUrl);
        }
        let host = authority.host().to_ascii_lowercase();
        if host.is_empty() {
            return Err(InvokeError::InvalidUrl);
        }
        let rule = rule_for(&self.rules, &req.provider_id)
            .ok_or_else(|| InvokeError::UnsupportedProvider(req.provider_id.clone()))?;
        // Egress fence, before anything else (I8): exact host match.
        if !rule.hosts.iter().any(|allowed| *allowed == host) {
            return Err(InvokeError::EgressDenied {
                provider: req.provider_id.clone(),
                host,
            });
        }
        let scheme = uri.scheme_str().unwrap_or("").to_ascii_lowercase();
        let loopback_http =
            self.allow_http_for_tests && scheme == "http" && is_loopback_host(&host);
        if scheme != rule.scheme && !loopback_http {
            return Err(InvokeError::HttpsRequired(scheme));
        }
        // A non-default port is fine on the loopback test path; on the real
        // path the allowlisted hosts are served on the scheme's default.
        if !loopback_http && uri.port_u16().is_some_and(|port| port != 443) {
            return Err(InvokeError::EgressDenied {
                provider: req.provider_id.clone(),
                host: authority.as_str().to_string(),
            });
        }
        let headers = filter_request_headers(&req.headers)?;
        let body = req.body.unwrap_or_default();
        if body.len() > self.request_body_cap {
            return Err(InvokeError::RequestBodyTooLarge {
                cap: self.request_body_cap,
            });
        }
        Ok(PreparedRequest {
            provider_id: req.provider_id,
            method,
            path: uri.path().to_string(),
            uri,
            scheme,
            host,
            headers,
            body,
            subject: req.subject,
            actor: req.actor,
        })
    }

    /// Execute a preflighted request with an acquired credential. The token
    /// is placed into exactly one sensitive header and dropped with the
    /// request; the response is the upstream's status, allowlisted headers,
    /// and capped body — never a redirect chase, never a cookie.
    pub async fn execute(
        &self,
        token: &SecretString,
        prepared: PreparedRequest,
    ) -> Result<InvokeResponse, InvokeError> {
        let started = Instant::now();
        let mut builder = hyper::Request::builder()
            .method(prepared.method.clone())
            .uri(prepared.uri.clone());
        for (name, value) in &prepared.headers {
            builder = builder.header(name, value);
        }
        if !prepared
            .headers
            .iter()
            .any(|(name, _)| name.as_str() == "user-agent")
        {
            builder = builder.header("user-agent", DEFAULT_USER_AGENT);
        }
        // The one place the token is materialized into the request. The
        // formatted `Bearer …` string is zeroized immediately after the
        // header value is built; the header itself is marked sensitive so
        // Debug representations redact it.
        let mut authorization =
            HeaderValue::from_str(&Zeroizing::new(format!("Bearer {}", token.expose_secret())))
                .map_err(|_| InvokeError::MalformedToken)?;
        authorization.set_sensitive(true);
        builder = builder.header(hyper::header::AUTHORIZATION, authorization);
        let request = builder
            .body(Full::new(prepared.body.clone()))
            .map_err(|_| InvokeError::InvalidUrl)?;

        let response = match tokio::time::timeout(self.timeout, self.client.request(request)).await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(InvokeError::Transport(error.to_string())),
            Err(_) => return Err(InvokeError::Timeout),
        };
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| {
                RESPONSE_HEADER_ALLOWLIST.contains(&name.as_str().to_ascii_lowercase().as_str())
            })
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
            })
            .collect();
        // A 3xx is data, not an instruction: it is returned exactly like any
        // other status. The client follows nothing on its own.
        let body = match tokio::time::timeout(
            self.timeout,
            Limited::new(response.into_body(), self.response_body_cap).collect(),
        )
        .await
        {
            Ok(Ok(collected)) => collected.to_bytes(),
            Ok(Err(_)) => {
                return Err(InvokeError::ResponseTooLarge {
                    cap: self.response_body_cap,
                })
            }
            Err(_) => return Err(InvokeError::Timeout),
        };
        Ok(InvokeResponse {
            status,
            headers,
            body,
            receipt: ReceiptMeta {
                provider_id: prepared.provider_id,
                scheme: prepared.scheme,
                host: prepared.host,
                path: prepared.path,
                status,
                latency_ms: started.elapsed().as_millis() as u64,
                subject: prepared.subject,
                actor: prepared.actor,
            },
        })
    }

    /// Preflight + acquire + execute in one step, for callers whose token
    /// source is cheap. Daemons should instead preflight, acquire on a
    /// blocking thread, then [`Invoker::execute`] — a denied request must
    /// never run the source tool.
    pub async fn execute_with_source(
        &self,
        source: &dyn TokenSource,
        req: InvokeRequest,
    ) -> Result<InvokeResponse, InvokeError> {
        let prepared = self.preflight(req)?;
        let token = source.acquire()?;
        self.execute(&token, prepared).await
    }
}

fn build_client() -> HttpsClient {
    let connector = HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .build();
    Client::builder(TokioExecutor::new()).build(connector)
}

fn parse_method(method: &str) -> Result<Method, InvokeError> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        "HEAD" => Ok(Method::HEAD),
        _ => Err(InvokeError::MethodNotAllowed(method.to_string())),
    }
}

fn filter_request_headers(
    headers: &[(String, String)],
) -> Result<Vec<(HeaderName, HeaderValue)>, InvokeError> {
    headers
        .iter()
        .map(|(name, value)| {
            let lowered = name.trim().to_ascii_lowercase();
            if !REQUEST_HEADER_ALLOWLIST.contains(&lowered.as_str()) {
                return Err(InvokeError::HeaderNotAllowed(lowered));
            }
            let name = HeaderName::from_bytes(lowered.as_bytes())
                .map_err(|_| InvokeError::HeaderNotAllowed(lowered.clone()))?;
            let value = HeaderValue::from_str(value)
                .map_err(|_| InvokeError::HeaderNotAllowed(lowered.clone()))?;
            Ok((name, value))
        })
        .collect()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "localhost")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::egress::AuthStyle;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use std::sync::Mutex;

    const CANARY: &str = "CANARY-TOKEN-7f3d9b-never-leaks";

    struct Recorded {
        hits: Vec<(String, Option<String>)>,
    }

    /// A loopback HTTP stub recording (path, authorization) per hit. The hit
    /// log is how egress tests prove the wire was never touched.
    async fn spawn_stub(
        responder: impl Fn(
                &hyper::Request<hyper::body::Incoming>,
            ) -> (u16, Vec<(&'static str, &'static str)>, &'static str)
            + Send
            + Sync
            + 'static,
    ) -> (String, Arc<Mutex<Recorded>>) {
        let recorded = Arc::new(Mutex::new(Recorded { hits: vec![] }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let recorded_task = recorded.clone();
        let responder = Arc::new(responder);
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let io = TokioIo::new(stream);
                let recorded = recorded_task.clone();
                let responder = responder.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let recorded = recorded.clone();
                        let responder = responder.clone();
                        async move {
                            let auth = req
                                .headers()
                                .get("authorization")
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_string);
                            let target = req.uri().path().to_string();
                            recorded.lock().unwrap().hits.push((target, auth));
                            let (status, headers, body) = responder(&req);
                            let mut response = hyper::Response::builder().status(status);
                            for (name, value) in headers {
                                response = response.header(name, value);
                            }
                            Ok::<_, std::convert::Infallible>(
                                response.body(Full::new(Bytes::from(body))).unwrap(),
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        });
        (format!("http://127.0.0.1:{}", addr.port()), recorded)
    }

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
}
