//! A recording TLS upstream standing in for `api.vercel.com`, on 127.0.0.1,
//! with disposable PKI. It keeps every request it receives, header values
//! included, so a test can say what did and did not cross the last hop.

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

/// What the upstream saw, one entry per request.
#[derive(Debug, Clone)]
pub struct Hit {
    pub method: String,
    pub path: String,
    pub authorization: Option<String>,
    /// Every header value, so "never crossed the wire" can be asserted for all.
    pub all_values: Vec<String>,
}

pub struct Upstream {
    pub addr: SocketAddr,
    pub ca: DisposableCa,
    hits: Arc<Mutex<Vec<Hit>>>,
    /// The server's own runtime, so a test stays an ordinary blocking test.
    _runtime: tokio::runtime::Runtime,
}

impl Upstream {
    pub fn hits(&self) -> Vec<Hit> {
        self.hits.lock().unwrap().clone()
    }

    /// The value of `OPENSESAME_SURROGATE_TEST_UPSTREAM` that aims the test
    /// build of the plugin at this server for `host`, trusting `ca_file`.
    pub fn override_value(&self, host: &str, ca_file: &std::path::Path) -> String {
        format!("{host}={},ca={}", self.addr, ca_file.display())
    }
}

fn server_config(ca: &DisposableCa, host: &str) -> rustls::ServerConfig {
    let leaf = ca.issue_server(host);
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&leaf.cert_pem)
        .map(|cert| cert.expect("certificate"))
        .collect();
    let key = PrivateKeyDer::from_pem_slice(leaf.key_pem.expose_secret()).expect("key");
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .expect("server config")
}

fn record(hits: &Mutex<Vec<Hit>>, req: &Request<Incoming>) {
    hits.lock().unwrap().push(Hit {
        method: req.method().to_string(),
        path: req.uri().path().to_owned(),
        authorization: req
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        all_values: req
            .headers()
            .values()
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
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
        async move {
            Ok::<_, std::convert::Infallible>(
                Response::builder()
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from_static(
                        b"{\"user\":{\"username\":\"octo\"}}",
                    )))
                    .unwrap(),
            )
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(tls), service)
        .await;
}

/// A TLS upstream for `host`, serving until it is dropped.
pub fn spawn(host: &str) -> Upstream {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let ca = DisposableCa::new(&format!("{host} upstream"));
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config(&ca, host)));
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let task_hits = Arc::clone(&hits);
    runtime.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_one(stream, acceptor.clone(), Arc::clone(&task_hits)));
        }
    });
    Upstream {
        addr,
        ca,
        hits,
        _runtime: runtime,
    }
}
