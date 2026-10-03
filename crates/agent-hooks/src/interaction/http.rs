//! The Identity API transport: https only (loopback http for tests), no
//! redirects, no proxy, bounded bodies, and nothing a server wrote ever
//! reaches an error.

use std::time::Duration;

use reqwest::{Client, StatusCode};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use super::InteractionConfigError;

/// The largest body read from the Identity API. An interaction detail is a
/// few kilobytes; anything past this is not an answer to our question.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long one request may take, unless the approver is told otherwise.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How one round trip is made.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    /// An `Idempotency-Key`. A create that carries one is retried once when
    /// no reply arrived, so a response lost on the way back cannot leave an
    /// interaction that nobody holds a reference to.
    pub key: Option<&'a str>,
    /// How long the request may take, whole (connect, send and read).
    pub timeout: Duration,
}

/// What came back: a status and, when the body was bounded JSON, the body.
#[derive(Debug)]
pub struct Reply {
    pub status: StatusCode,
    pub body: Option<Value>,
}

impl Reply {
    /// The stable error code (`{"error": "..."}`), when there is one. Only
    /// ever compared against a closed vocabulary, never echoed.
    pub fn error_code(&self) -> Option<&str> {
        self.body.as_ref()?.get("error")?.as_str()
    }
}

/// Why a round trip produced no reply. Carries nothing the server wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportFailed;

/// An authenticated client for one Identity API origin.
pub struct IdentityClient {
    base: Url,
    bearer: SecretString,
    http: Client,
}

impl std::fmt::Debug for IdentityClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdentityClient")
            .field("base", &self.base.as_str())
            .field("bearer", &"[redacted]")
            .finish_non_exhaustive()
    }
}

/// https, or http to a loopback host so offline tests can run against a
/// stub. No embedded credentials, no query, no fragment.
///
/// # Errors
///
/// [`InteractionConfigError::InvalidUrl`] or
/// [`InteractionConfigError::InsecureUrl`].
pub fn parse_base(raw: &str) -> Result<Url, InteractionConfigError> {
    let url = Url::parse(raw.trim()).map_err(|_| InteractionConfigError::InvalidUrl)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(InteractionConfigError::InvalidUrl);
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => return Err(InteractionConfigError::InvalidUrl),
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(InteractionConfigError::InsecureUrl),
    }
}

impl IdentityClient {
    /// A client for `base`, authenticated by `bearer`.
    ///
    /// # Errors
    ///
    /// [`InteractionConfigError::Transport`] when the TLS client cannot be
    /// built.
    pub fn new(base: Url, bearer: SecretString) -> Result<Self, InteractionConfigError> {
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .https_only(base.scheme() == "https")
            .build()
            .map_err(|_| InteractionConfigError::Transport)?;
        Ok(Self { base, bearer, http })
    }

    fn endpoint(&self, path: &str) -> Result<Url, TransportFailed> {
        let joined = format!("{}{path}", self.base.as_str().trim_end_matches('/'));
        Url::parse(&joined).map_err(|_| TransportFailed)
    }

    /// `POST path` with a JSON body (or none), bearer-authenticated.
    ///
    /// A call carrying an idempotency key is attempted twice when the first
    /// attempt produced no reply at all (connect, TLS, timeout): the server
    /// replays the recorded answer if it had processed the first, so the
    /// second attempt finds out what happened rather than doing it again.
    ///
    /// # Errors
    ///
    /// [`TransportFailed`] when no reply arrived.
    pub async fn post<B: Serialize + Sync>(
        &self,
        path: &str,
        body: Option<&B>,
        call: Call<'_>,
    ) -> Result<Reply, TransportFailed> {
        let first = self.attempt(path, body, call).await;
        if first.is_err() && call.key.is_some() {
            return self.attempt(path, body, call).await;
        }
        first
    }

    async fn attempt<B: Serialize + Sync>(
        &self,
        path: &str,
        body: Option<&B>,
        call: Call<'_>,
    ) -> Result<Reply, TransportFailed> {
        let mut request = self
            .http
            .post(self.endpoint(path)?)
            .bearer_auth(self.bearer.expose_secret())
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(call.timeout);
        if let Some(key) = call.key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|_| TransportFailed)?;
        let status = response.status();
        Ok(Reply {
            status,
            body: read_bounded(response).await,
        })
    }
}

/// The body as JSON, or `None` when it is too large, unreadable or not JSON.
async fn read_bounded(mut response: reqwest::Response) -> Option<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}
