//! A loopback TLS upstream standing in for a provider API, with disposable
//! PKI from the transport-security testkit. It records every header value it
//! receives, so a test can prove what did and did not cross the wire.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use opensesame_transport_security::testkit::DisposableCa;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use secrecy::ExposeSecret;

/// What the stub saw, one entry per request.
#[derive(Debug, Clone)]
pub struct Hit {
    pub path: String,
    pub authorization: Option<String>,
    /// Every header value, for "never crossed the wire" assertions.
    pub all_values: Vec<String>,
}

pub struct Upstream {
    pub host: &'static str,
    pub addr: SocketAddr,
    pub ca: DisposableCa,
    pub hits: Arc<Mutex<Vec<Hit>>>,
}

impl Upstream {
    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().unwrap().clone()
    }

    /// A client config that trusts only this stub's CA.
    pub fn client_config(&self) -> rustls::ClientConfig {
        client_trusting(&self.ca.ca_der())
    }
}

pub fn client_trusting(ca_der: &[u8]) -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from(ca_der.to_vec()))
        .expect("root");
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

fn server_config(ca: &DisposableCa, host: &str) -> rustls::ServerConfig {
    let leaf = ca.issue_server(host);
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&leaf.cert_pem)
        .map(|cert| cert.expect("cert"))
        .collect();
    let key = PrivateKeyDer::from_pem_slice(leaf.key_pem.expose_secret()).expect("key");
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .expect("server config")
}

/// Answers by path. `/reflect` echoes the Authorization it received, in the
/// body and in an allowlisted response header: an upstream that reflects.
fn respond(req: &Request<Incoming>) -> Response<Full<Bytes>> {
    let auth = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if req.uri().path() == "/reflect" {
        return Response::builder()
            .header("content-type", "application/json")
            .header("x-github-request-id", auth.clone())
            .body(Full::new(Bytes::from(format!("{{\"echo\":\"{auth}\"}}"))))
            .unwrap();
    }
    Response::builder()
        .header("content-type", "application/json")
        .header("set-cookie", "upstream=session")
        .body(Full::new(Bytes::from_static(b"{\"login\":\"octo\"}")))
        .unwrap()
}

fn record(hits: &Mutex<Vec<Hit>>, req: &Request<Incoming>) {
    hits.lock().unwrap().push(Hit {
        path: req.uri().path().to_owned(),
        authorization: req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        all_values: req
            .headers()
            .values()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect(),
    });
}

async fn serve_one(
    stream: tokio::net::TcpStream,
    acceptor: tokio_rustls::TlsAcceptor,
    hits: Arc<Mutex<Vec<Hit>>>,
) {
    let Ok(tls) = acceptor.accept(stream).await else {
        return;
    };
    let service = service_fn(move |req: Request<Incoming>| {
        record(&hits, &req);
        let response = respond(&req);
        async move { Ok::<_, std::convert::Infallible>(response) }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(tls), service)
        .await;
}

/// A TLS upstream for `host` on 127.0.0.1.
pub async fn spawn_upstream(host: &'static str) -> Upstream {
    let ca = DisposableCa::new(&format!("{host} upstream"));
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config(&ca, host)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let task_hits = Arc::clone(&hits);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_one(stream, acceptor.clone(), Arc::clone(&task_hits)));
        }
    });
    Upstream {
        host,
        addr,
        ca,
        hits,
    }
}
