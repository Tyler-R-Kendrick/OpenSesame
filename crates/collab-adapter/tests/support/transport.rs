//! A real HTTP transport over `hyper`, plus a backoff that records instead of
//! sleeping.
//!
//! Real HTTP on purpose: the fixture is reached over a socket, so the suite
//! exercises header construction, JSON bodies, `204 No Content`, and status
//! interpretation the way production will. A hand-written in-memory transport
//! would let a malformed header or a wrong content type pass.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use opensesame_collab_adapter::transport::{
    CollabTransport, TransportError, WireRequest, WireResponse,
};
use opensesame_collab_adapter::{Backoff, BotToken, CredentialKind};

/// The fixture's bot token. Synthetic; not a credential.
pub const FIXTURE_BOT_TOKEN: &str = "fixture.bot.token";

#[must_use]
pub fn bot_token() -> BotToken {
    BotToken::from_credential(CredentialKind::BotToken, FIXTURE_BOT_TOKEN)
        .expect("a bot credential is accepted")
}

pub struct HyperTransport {
    client: Client<hyper_util::client::legacy::connect::HttpConnector, Full<Bytes>>,
}

impl HyperTransport {
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: Client::builder(TokioExecutor::new()).build_http(),
        }
    }
}

impl Default for HyperTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CollabTransport for HyperTransport {
    async fn send(&self, request: WireRequest) -> Result<WireResponse, TransportError> {
        let mut builder = hyper::Request::builder()
            .method(request.method.as_str())
            .uri(&request.url)
            .header("authorization", &request.authorization)
            .header("user-agent", "OpenSesame-collab-adapter/0.1 (fixture)");
        if let Some(reason) = &request.audit_reason {
            builder = builder.header("x-audit-log-reason", reason);
        }
        let body = match &request.body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Full::new(Bytes::from(value.to_string()))
            }
            None => Full::new(Bytes::new()),
        };
        let http_request = builder
            .body(body)
            .map_err(|error| TransportError::Network(error.to_string()))?;

        let response = self
            .client
            .request(http_request)
            .await
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        // A redirect carrying an `Authorization` header to wherever `Location`
        // points is exactly what this must never do, so it is a refusal here
        // rather than a client setting somebody could flip.
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            return Err(TransportError::Redirect { location });
        }
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
            })
            .collect();
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|error| TransportError::Decode(error.to_string()))?
            .to_bytes()
            .to_vec();
        Ok(WireResponse {
            status,
            headers,
            body,
        })
    }
}

/// A [`Backoff`] that records what it was asked to wait for and returns at once.
///
/// The recording is the assertion: `tests/rate_limit.rs` checks the adapter
/// asked for `0.25` seconds — the float from the 429 body — rather than the
/// integer a `Retry-After` header would have rounded it to.
#[derive(Clone, Debug, Default)]
pub struct RecordingBackoff {
    waits: Arc<Mutex<Vec<f64>>>,
}

impl RecordingBackoff {
    #[must_use]
    pub fn waits(&self) -> Vec<f64> {
        self.waits.lock().unwrap().clone()
    }
}

#[async_trait]
impl Backoff for RecordingBackoff {
    async fn wait(&self, seconds: f64) {
        self.waits.lock().unwrap().push(seconds);
    }
}
