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
//! cert store, no reqwest, no cookie store — the ADR 0048 D5 budget), or the
//! scoped profile the authority plane injects through [`Invoker::with_tls`].

use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::HeaderValue;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::egress::{EgressRule, EGRESS_RULES};
use crate::error::InvokeError;
use crate::fence::{EgressFence, PreparedRequest};
use crate::scrub::Needles;
use crate::source::TokenSource;
use crate::tls::{build_client, HttpsClient, TlsClientSpec};

#[cfg(test)]
#[path = "invoke_stub.rs"]
mod stub;

/// Outbound body cap: generous for an API payload, useless for exfiltration.
pub const DEFAULT_REQUEST_BODY_CAP: usize = 256 * 1024;
/// Inbound body cap (ADR 0048 D7: the upstream response only, capped).
pub const DEFAULT_RESPONSE_BODY_CAP: usize = 1024 * 1024;
/// Whole-call timeout, connect through last body byte.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

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

/// One validated invoke-through call.
pub struct InvokeRequest {
    pub provider_id: String,
    pub method: String,
    pub url: String,
    /// Name/value pairs; each name must pass
    /// [`forwardable_request_header`](crate::forwardable_request_header) for
    /// this provider.
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
    /// The upstream echoed the credential and the broker scrubbed it. Never
    /// expected from a well-behaved API, so it is worth a look when set.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub credential_reflected: bool,
}

/// The broker. Cheap to build; the daemon holds one in shared state.
pub struct Invoker {
    client: HttpsClient,
    /// Every pre-connect check, separable so a caller can run it before any
    /// identity is resolved or credential opened.
    fence: EgressFence,
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
    #[must_use]
    pub fn new() -> Self {
        Self::with_rules(EGRESS_RULES.to_vec())
    }

    /// Broker over an explicit rule set. Still https only — see
    /// [`Invoker::allow_http_for_tests`].
    #[must_use]
    pub fn with_rules(rules: Vec<EgressRule>) -> Self {
        Self::from_client(build_client(None), rules)
    }

    /// Broker over an explicit rule set and an injected, already-validated
    /// TLS profile (server trust, expected server name, optional client
    /// identity, pinned addresses). Https only: the injected config is the
    /// only trust this client has. The egress allowlist, no-redirect, header
    /// and body fences are exactly those of [`Invoker::with_rules`].
    #[must_use]
    pub fn with_tls(rules: Vec<EgressRule>, tls: &TlsClientSpec) -> Self {
        Self::from_client(build_client(Some(tls)), rules)
    }

    fn from_client(client: HttpsClient, rules: Vec<EgressRule>) -> Self {
        Self {
            client,
            fence: EgressFence::new(rules, DEFAULT_REQUEST_BODY_CAP),
            response_body_cap: DEFAULT_RESPONSE_BODY_CAP,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// The pre-connect fence alone, for a caller that must clear a request
    /// before resolving an identity or opening a credential.
    #[must_use]
    pub fn fence(&self) -> &EgressFence {
        &self.fence
    }

    /// Test mode: permit plain HTTP **to loopback hosts only**, for
    /// in-process stubs, and a non-default port on either scheme (a test TLS
    /// listener binds port 0). The egress allowlist still applies; this
    /// relaxes the scheme check alone, and only for 127.0.0.1 / `::1` /
    /// localhost.
    #[must_use]
    pub fn allow_http_for_tests(mut self) -> Self {
        self.fence.allow_http_for_tests = true;
        self
    }

    /// Override the body caps (tests exercise them with small values).
    #[must_use]
    pub fn with_caps(mut self, request_body_cap: usize, response_body_cap: usize) -> Self {
        self.fence.request_body_cap = request_body_cap;
        self.response_body_cap = response_body_cap;
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Validate every fence that must hold before a credential is touched or
    /// a socket is opened: provider adapter, egress allowlist (exact host
    /// match), https, method, header allowlist, body cap.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn preflight(&self, req: InvokeRequest) -> Result<PreparedRequest, InvokeError> {
        self.fence.preflight(req)
    }

    /// Execute a preflighted request with an acquired credential. The token
    /// is placed into exactly one sensitive header and dropped with the
    /// request; the response is the upstream's status, allowlisted headers,
    /// and capped body — never a redirect chase, never a cookie.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
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
        // Built before anything upstream sent is read: every header and the
        // body pass through it on the way back (ADR 0150 §4).
        let needles = Needles::new(token.expose_secret());
        let mut credential_reflected = false;
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| {
                RESPONSE_HEADER_ALLOWLIST.contains(&name.as_str().to_ascii_lowercase().as_str())
            })
            .filter_map(|(name, value)| {
                let (value, hit) = needles.scrub_str(value.to_str().ok()?.to_string());
                credential_reflected |= hit;
                Some((name.as_str().to_string(), value))
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
            Ok(Err(error)) => {
                // Limited boxes its errors: LengthLimitError means the cap was
                // hit; anything else is the underlying body read failing (e.g.
                // a truncated mid-body EOF), which is a transport fault.
                if error
                    .downcast_ref::<http_body_util::LengthLimitError>()
                    .is_some()
                {
                    return Err(InvokeError::ResponseTooLarge {
                        cap: self.response_body_cap,
                    });
                }
                return Err(InvokeError::Transport(error.to_string()));
            }
            Err(_) => return Err(InvokeError::Timeout),
        };
        let (body, body_hit) = needles.scrub(body);
        credential_reflected |= body_hit;
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
                latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                subject: prepared.subject,
                actor: prepared.actor,
                credential_reflected,
            },
        })
    }

    /// Preflight + acquire + execute in one step, for callers whose token
    /// source is cheap. Daemons should instead preflight, acquire on a
    /// blocking thread, then [`Invoker::execute`] — a denied request must
    /// never run the source tool.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
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

#[cfg(test)]
#[path = "invoke_tests.rs"]
mod tests;
