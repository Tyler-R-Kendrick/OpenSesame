//! The pre-connect fence, with no client attached.
//!
//! Every check that must hold *before* a socket is opened or a credential is
//! touched lives here: the provider adapter, the egress allowlist (exact host
//! match, no wildcards), the scheme, the method, the request-header allowlist
//! and the body cap. [`Invoker::preflight`](crate::Invoker::preflight)
//! delegates to it unchanged.
//!
//! Keeping the fence separate from the wire client is what lets a caller run
//! it *first* and only afterwards resolve an identity or build a credentialed
//! client (ADR 0130, CONN-EXECUTE): a request the fence denies never causes a
//! TLS identity to be resolved, a sealed credential to be opened, or a pooled
//! client to be created.

use bytes::Bytes;
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Method, Uri};

use crate::egress::{rule_for, EgressRule};
use crate::error::InvokeError;
use crate::invoke::InvokeRequest;

/// Headers a caller may set. `authorization` is deliberately absent: the
/// broker owns it.
pub(crate) const REQUEST_HEADER_ALLOWLIST: &[&str] = &["accept", "content-type", "user-agent"];

/// A request that has passed every pre-connect fence. Constructing one is
/// proof the egress allowlist, scheme, method, header allowlist, and body cap
/// all checked out. Carries no credential — the token is added in
/// [`Invoker::execute`](crate::Invoker::execute) and dies with the wire
/// request.
#[derive(Debug)]
pub struct PreparedRequest {
    pub(crate) provider_id: String,
    pub(crate) method: Method,
    pub(crate) uri: Uri,
    pub(crate) scheme: String,
    pub(crate) host: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(HeaderName, HeaderValue)>,
    pub(crate) body: Bytes,
    pub(crate) subject: Option<String>,
    pub(crate) actor: Option<String>,
}

impl PreparedRequest {
    /// The exact host this request was cleared for. A credentialed client may
    /// be pinned to it, so nothing resolved later can point elsewhere.
    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The port the cleared URI names, when it names one.
    #[must_use]
    pub fn port(&self) -> Option<u16> {
        self.uri.port_u16()
    }
}

/// The fence's configuration: the rules it enforces and the two knobs tests
/// move.
#[derive(Clone, Debug)]
pub struct EgressFence {
    pub(crate) rules: std::sync::Arc<Vec<EgressRule>>,
    /// Loopback-only HTTP for tests. Never set in production construction.
    pub(crate) allow_http_for_tests: bool,
    pub(crate) request_body_cap: usize,
}

impl EgressFence {
    /// A fence over an explicit rule set. Https only — see
    /// [`EgressFence::allow_http_for_tests`].
    #[must_use]
    pub fn new(rules: Vec<EgressRule>, request_body_cap: usize) -> Self {
        Self {
            rules: std::sync::Arc::new(rules),
            allow_http_for_tests: false,
            request_body_cap,
        }
    }

    /// Test mode: permit plain HTTP to loopback hosts only, and a non-default
    /// port on either scheme (a test TLS listener binds port 0). The egress
    /// allowlist still applies.
    #[must_use]
    pub fn allow_http_for_tests(mut self) -> Self {
        self.allow_http_for_tests = true;
        self
    }

    /// The rules this fence enforces.
    #[must_use]
    pub fn rules(&self) -> &[EgressRule] {
        &self.rules
    }

    /// Validate every fence that must hold before a credential is touched or
    /// a socket is opened.
    ///
    /// # Errors
    ///
    /// `UnsupportedProvider` for a provider with no rule, `EgressDenied` for a
    /// host the rule does not name or a non-default port, `HttpsRequired` for
    /// a plain-http target, `InvalidUrl` for a malformed or userinfo-bearing
    /// URL, `MethodNotAllowed`, `HeaderNotAllowed`, `RequestBodyTooLarge`.
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
        // A non-default port is fine in test mode; on the real path the
        // allowlisted hosts are served on the scheme's default.
        if !self.allow_http_for_tests && uri.port_u16().is_some_and(|port| port != 443) {
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
