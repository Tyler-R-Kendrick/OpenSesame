//! The one road for traffic that carries no surrogate: a host the run named
//! as passthrough, tunnelled on without any credential of ours.
//!
//! It is off unless a run lists hosts, and default-empty is the ADR's default
//! refuse (§6.1). The request was still terminated and scanned — that is how
//! a surrogate sent to a passthrough host trips `surrogate.misdirected`
//! instead of riding out — so its body is bounded by the same cap as every
//! other scanned request. The response streams back untouched: nothing of
//! ours was in the request, so there is nothing of ours to scrub.
//!
//! The wire client is https only, verifies against webpki roots (or the
//! config an embedder injects), never follows a redirect, and sends nothing
//! hop-by-hop or proxy-scoped that the child wrote.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::header::HeaderMap;
use hyper::{Request, Response};
use hyper_rustls::{ConfigBuilderExt as _, HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use opensesame_invoke_through::Resolver;

use crate::respond::{self, ProxyBody};

/// Response-header deadline for a passthrough call.
const PASSTHROUGH_TIMEOUT: Duration = Duration::from_secs(30);

/// Headers that describe one hop, or the proxy itself, and never travel on.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
];

type WireClient = Client<HttpsConnector<HttpConnector<Resolver>>, Full<Bytes>>;

/// The passthrough wire client.
#[derive(Clone)]
pub struct PassthroughClient {
    client: WireClient,
}

impl std::fmt::Debug for PassthroughClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PassthroughClient").finish_non_exhaustive()
    }
}

impl Default for PassthroughClient {
    fn default() -> Self {
        Self::webpki()
    }
}

impl PassthroughClient {
    /// Webpki roots, system DNS, https only.
    ///
    /// # Panics
    ///
    /// Never in practice: the `ring` provider always offers rustls's safe
    /// default protocol versions.
    #[must_use]
    pub fn webpki() -> Self {
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports the default protocol versions")
        .with_webpki_roots()
        .with_no_client_auth();
        Self::with_tls(config, None)
    }

    /// An injected client config, optionally pinned to one host's addresses
    /// (tests dial a loopback stub this way).
    #[must_use]
    pub fn with_tls(config: rustls::ClientConfig, pinned: Option<(&str, &[SocketAddr])>) -> Self {
        let resolver = match pinned {
            Some((host, addrs)) => Resolver::pinned(host, addrs),
            None => Resolver::system(),
        };
        let mut http = HttpConnector::new_with_resolver(resolver);
        http.enforce_http(false);
        let connector = HttpsConnectorBuilder::new()
            .with_tls_config(config)
            .https_only()
            .enable_http1()
            .wrap_connector(http);
        Self {
            client: Client::builder(TokioExecutor::new()).build(connector),
        }
    }

    /// Forward one scanned request to `https://authority/path_and_query`.
    pub(crate) async fn forward(
        &self,
        method: &hyper::Method,
        authority: &str,
        path_and_query: &str,
        headers: &HeaderMap,
        body: Bytes,
    ) -> Response<ProxyBody> {
        match self
            .send(method, authority, path_and_query, end_to_end(headers), body)
            .await
        {
            Ok(response) => {
                let (mut parts, body) = response.into_parts();
                parts.headers = end_to_end(&parts.headers);
                Response::from_parts(parts, body.boxed())
            }
            Err(status) if status == http::StatusCode::BAD_REQUEST => respond::refused(status),
            Err(status) => respond::upstream_failed(status),
        }
    }

    /// Send one request as given and hand back the upstream's response, or
    /// the status that stands for its failure: `400` for a request that could
    /// not be built, `502` for a transport failure, `504` past the deadline.
    pub(crate) async fn send(
        &self,
        method: &hyper::Method,
        authority: &str,
        path_and_query: &str,
        headers: HeaderMap,
        body: Bytes,
    ) -> Result<Response<hyper::body::Incoming>, http::StatusCode> {
        let Ok(mut request) = Request::builder()
            .method(method.clone())
            .uri(format!("https://{authority}{path_and_query}"))
            .body(Full::new(body))
        else {
            return Err(http::StatusCode::BAD_REQUEST);
        };
        *request.headers_mut() = headers;
        match tokio::time::timeout(PASSTHROUGH_TIMEOUT, self.client.request(request)).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(http::StatusCode::BAD_GATEWAY),
            Err(_) => Err(http::StatusCode::GATEWAY_TIMEOUT),
        }
    }
}

/// `headers` without the hop-by-hop set and without any header the message's
/// own `Connection` names (RFC 9110 §7.6.1).
pub(crate) fn end_to_end(headers: &HeaderMap) -> HeaderMap {
    let named: Vec<String> = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .collect();
    let mut kept = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let lowered = name.as_str();
        if !HOP_BY_HOP.contains(&lowered) && !named.iter().any(|n| n == lowered) {
            kept.append(name.clone(), value.clone());
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderName;

    #[test]
    fn hop_by_hop_and_connection_named_headers_never_travel() {
        let mut headers = HeaderMap::new();
        headers.insert("connection", "keep-alive, X-Trace".parse().unwrap());
        headers.insert("x-trace", "hop".parse().unwrap());
        headers.insert("proxy-authorization", "Basic x".parse().unwrap());
        headers.insert("host", "static.test".parse().unwrap());
        headers.insert("accept", "*/*".parse().unwrap());
        headers.append("x-multi", "a".parse().unwrap());
        headers.append("x-multi", "b".parse().unwrap());
        let kept = end_to_end(&headers);
        let names: Vec<&str> = kept.keys().map(HeaderName::as_str).collect();
        assert_eq!(names, vec!["accept", "x-multi"]);
        assert_eq!(kept.get_all("x-multi").iter().count(), 2);
    }
}
