//! TLS client injection for invoke-through (ADR 0132, SW-CONNECTOR).
//!
//! The authority plane builds a *scoped* `rustls::ClientConfig` — the bundle
//! that verifies the server, the exact server identity expected, and
//! optionally the client identity to present — with
//! `opensesame-transport-security`, and hands it here as an opaque,
//! already-validated object. This crate never reads PEM, never selects a
//! certificate from a request, and gains no dependency: `rustls` and
//! `hyper-util` are already in its tree through `hyper-rustls`.
//!
//! Two things are pinned alongside the config. The **server name** rustls
//! verifies may be fixed independently of the URI host, so a DNS policy
//! (`connector.example`) holds whatever address the connection dials. The
//! **addresses** the connector may reach are the ones the egress preflight
//! resolved and checked; a name is never resolved a second time between the
//! check and the dial, so a DNS rebind cannot point a credentialed request
//! elsewhere. A pinned client refuses every other host outright.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body_util::Full;
use hyper::Uri;
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder, ResolveServerName};
use hyper_util::client::legacy::connect::dns::{GaiResolver, Name};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use rustls::pki_types::ServerName;
use tower_service::Service;

/// An injected, already-validated TLS client profile.
pub struct TlsClientSpec {
    /// Built by `opensesame_transport_security::client_config`: server trust,
    /// server-name policy and optional client identity are all inside.
    pub config: Arc<rustls::ClientConfig>,
    /// The reference identity rustls verifies when it is not the URI host
    /// (a DNS server-name policy dialed by address or alias).
    pub server_name: Option<ServerName<'static>>,
    /// `(host, addresses)`: the only host this client may dial and the
    /// addresses the egress preflight already checked for it.
    pub pinned: Option<(String, Vec<SocketAddr>)>,
}

impl std::fmt::Debug for TlsClientSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsClientSpec")
            .field("server_name", &self.server_name)
            .field("pinned", &self.pinned)
            .finish_non_exhaustive()
    }
}

/// Hands rustls one fixed `ServerName` whatever URI is dialed.
struct FixedServerName(ServerName<'static>);

impl ResolveServerName for FixedServerName {
    fn resolve(
        &self,
        _uri: &Uri,
    ) -> Result<ServerName<'static>, Box<dyn std::error::Error + Sync + Send>> {
        Ok(self.0.clone())
    }
}

/// Name resolution for the connector: the system resolver, or a pinned
/// answer for exactly one host.
#[derive(Clone)]
pub enum Resolver {
    System(GaiResolver),
    Pinned {
        host: String,
        addrs: Vec<SocketAddr>,
    },
}

impl Resolver {
    #[must_use]
    pub fn system() -> Self {
        Self::System(GaiResolver::new())
    }

    #[must_use]
    pub fn pinned(host: &str, addrs: &[SocketAddr]) -> Self {
        Self::Pinned {
            host: host.to_ascii_lowercase(),
            addrs: addrs.to_vec(),
        }
    }
}

type ResolveFuture =
    Pin<Box<dyn Future<Output = Result<std::vec::IntoIter<SocketAddr>, std::io::Error>> + Send>>;

impl Service<Name> for Resolver {
    type Response = std::vec::IntoIter<SocketAddr>;
    type Error = std::io::Error;
    type Future = ResolveFuture;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        match self {
            Self::System(gai) => gai.poll_ready(cx),
            Self::Pinned { .. } => Poll::Ready(Ok(())),
        }
    }

    fn call(&mut self, name: Name) -> Self::Future {
        match self {
            Self::System(gai) => {
                let fut = gai.call(name);
                Box::pin(
                    async move { fut.await.map(|addrs| addrs.collect::<Vec<_>>().into_iter()) },
                )
            }
            Self::Pinned { host, addrs } => {
                let result = if name.as_str().eq_ignore_ascii_case(host) {
                    Ok(addrs.clone().into_iter())
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "host is not the pinned connector authority",
                    ))
                };
                Box::pin(async move { result })
            }
        }
    }
}

pub(crate) type HttpsClient = Client<HttpsConnector<HttpConnector<Resolver>>, Full<Bytes>>;

/// The wire client. Without a spec: webpki roots, system DNS, https or
/// loopback http. With one: the injected config only, https only, the
/// pinned server name and addresses when given.
pub(crate) fn build_client(tls: Option<&TlsClientSpec>) -> HttpsClient {
    let resolver = match tls.and_then(|spec| spec.pinned.as_ref()) {
        Some((host, addrs)) => Resolver::pinned(host, addrs),
        None => Resolver::system(),
    };
    let mut http = HttpConnector::new_with_resolver(resolver);
    http.enforce_http(false);
    let connector = match tls {
        Some(spec) => {
            let builder = HttpsConnectorBuilder::new()
                .with_tls_config((*spec.config).clone())
                .https_only();
            let builder = match &spec.server_name {
                Some(name) => builder.with_server_name_resolver(FixedServerName(name.clone())),
                None => builder,
            };
            builder.enable_http1().enable_http2().wrap_connector(http)
        }
        None => HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_or_http()
            .enable_http1()
            .enable_http2()
            .wrap_connector(http),
    };
    Client::builder(TokioExecutor::new()).build(connector)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn resolve(
        resolver: &mut Resolver,
        host: &str,
    ) -> Result<Vec<SocketAddr>, std::io::Error> {
        let name: Name = host.parse().expect("name");
        resolver.call(name).await.map(Iterator::collect)
    }

    #[tokio::test]
    async fn pinned_resolver_answers_only_its_host() {
        let addr: SocketAddr = "127.0.0.1:4433".parse().unwrap();
        let mut resolver = Resolver::pinned("Connector.Example", &[addr]);
        assert_eq!(
            resolve(&mut resolver, "connector.example").await.unwrap(),
            vec![addr]
        );
        let err = resolve(&mut resolver, "other.example")
            .await
            .expect_err("a pinned client dials nothing else");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn spec_debug_never_prints_the_config() {
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
        let spec = TlsClientSpec {
            config: Arc::new(config),
            server_name: Some(ServerName::try_from("connector.example").unwrap()),
            pinned: None,
        };
        let rendered = format!("{spec:?}");
        assert!(rendered.contains("connector.example"));
        assert!(!rendered.contains("ClientConfig"));
    }
}
