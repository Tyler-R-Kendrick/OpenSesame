//! The HTTP seam.
//!
//! This crate builds and interprets requests; it does not own a client. A
//! caller supplies [`CollabTransport`], which is how `tests/` drives the whole
//! adapter against a loopback fixture with no network and no feature flags, and
//! how the gateway can route the same requests through
//! `crates/invoke-through`'s egress allowlist rather than opening its own
//! socket.
//!
//! [`WireRequest`] carries a complete `Authorization` header rather than a
//! token, because [`crate::credential::BotToken`] has no other way out. Its
//! `Debug` redacts that header: a transport implementation that logs the request
//! it was handed is normal, and it should not be the thing that puts a bot token
//! in a log file.

use std::collections::BTreeMap;
use std::fmt;

use async_trait::async_trait;
use serde_json::Value;
use thiserror::Error;

/// The HTTP methods Discord's REST surface needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

impl Method {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Patch => "PATCH",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
        }
    }
}

/// One request, fully formed.
#[derive(Clone, PartialEq, Eq)]
pub struct WireRequest {
    pub method: Method,
    pub url: String,
    /// A complete header value, always `Bot …`.
    pub authorization: String,
    /// `X-Audit-Log-Reason`, present on every mutation.
    pub audit_reason: Option<String>,
    pub body: Option<Value>,
}

impl fmt::Debug for WireRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WireRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("authorization", &"<redacted>")
            .field("audit_reason", &self.audit_reason)
            .field("body", &self.body)
            .finish()
    }
}

/// One response, as the transport read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireResponse {
    pub status: u16,
    /// Lowercased header names.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl WireResponse {
    #[must_use]
    pub const fn is_success(&self) -> bool {
        self.status >= 200 && self.status < 300
    }

    #[must_use]
    pub const fn is_rate_limited(&self) -> bool {
        self.status == 429
    }

    /// Seconds to wait, from Discord's 429 body.
    ///
    /// Discord answers a 429 with a JSON body carrying `retry_after` as a
    /// **float of seconds** — `0.75` is normal and common. Reading the integer
    /// `Retry-After` header instead rounds sub-second waits down to zero and
    /// produces a hot retry loop, so the body is the source and the header is
    /// only the fallback.
    #[must_use]
    pub fn retry_after_seconds(&self) -> Option<f64> {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|body| body.get("retry_after").and_then(Value::as_f64))
            .or_else(|| {
                self.headers
                    .get("retry-after")
                    .and_then(|raw| raw.parse::<f64>().ok())
            })
    }

    /// Whether the 429 is Discord's per-bot global limit rather than a
    /// per-route bucket. A global limit means back off everything, not just
    /// this route.
    #[must_use]
    pub fn is_global_rate_limit(&self) -> bool {
        self.headers
            .get("x-ratelimit-global")
            .is_some_and(|value| value == "true")
            || serde_json::from_slice::<Value>(&self.body)
                .ok()
                .and_then(|body| body.get("global").and_then(Value::as_bool))
                .unwrap_or(false)
    }
}

/// A failure below the protocol: the request never got an answer worth
/// interpreting.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum TransportError {
    #[error("transport failed: {0}")]
    Network(String),
    /// A redirect. Not followed, ever: a followed redirect is a request with an
    /// `Authorization` header going to a host nobody allowlisted.
    #[error("refusing to follow a redirect to {location}")]
    Redirect { location: String },
    #[error("could not decode the response: {0}")]
    Decode(String),
}

/// The HTTP surface this adapter needs.
///
/// One method. An implementation must not follow redirects and must not retry on
/// its own — [`crate::executor`] owns the rate-limit backoff, because it is the
/// only layer that knows whether a step is safe to repeat.
#[async_trait]
pub trait CollabTransport: Send + Sync {
    async fn send(&self, request: WireRequest) -> Result<WireResponse, TransportError>;
}
