//! Shared harness: a Bitwarden-compatible server mounted where the Host mounts
//! it (`/bitwarden`), served on loopback over plain HTTP and over HTTPS, plus
//! a Bitwarden *client* built from `opensesame-provider-bitwarden`'s crypto.
#![allow(dead_code)] // each test crate uses a different slice of the harness

pub mod bw;
pub mod client;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::service::TowerToHyperService;
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::{BitwardenServer, ServerConfig, SignupPolicy};
use opensesame_storage::Db;
use tokio::net::TcpListener;

pub const MOUNT: &str = "/bitwarden";

/// Every request the server saw, and every one it had no route for.
#[derive(Clone, Default)]
pub struct Trace {
    pub seen: Arc<Mutex<Vec<String>>>,
    pub unrouted: Arc<Mutex<Vec<String>>>,
}

pub struct Harness {
    pub db: Db,
    pub server: BitwardenServer,
    pub http_url: String,
    pub https_url: String,
    pub ca_pem: String,
    pub trace: Trace,
}

async fn record(
    axum::extract::State(trace): axum::extract::State<Trace>,
    request: Request,
    next: Next,
) -> Response {
    let line = format!("{} {}", request.method(), request.uri().path());
    trace.seen.lock().unwrap().push(line.clone());
    let response = next.run(request).await;
    if response.status() == StatusCode::NOT_FOUND
        || response.status() == StatusCode::METHOD_NOT_ALLOWED
    {
        trace
            .unrouted
            .lock()
            .unwrap()
            .push(format!("{line} -> {}", response.status()));
    }
    response
}

fn app(server: BitwardenServer, trace: Trace) -> Router {
    Router::new()
        .nest(MOUNT, server.router())
        .layer(middleware::from_fn_with_state(trace, record))
}

fn tls_config() -> (Arc<rustls::ServerConfig>, String) {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(
        rcgen::DnType::CommonName,
        "OpenSesame bitwarden-compat test CA",
    );
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec!["localhost".into(), "127.0.0.1".into()])
        .unwrap()
        .signed_by(&leaf_key, &issuer)
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der().clone(), ca_cert.der().clone()],
            rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()),
        )
        .unwrap();
    (Arc::new(config), ca_cert.pem())
}

async fn serve_plain(listener: TcpListener, app: Router) {
    axum::serve(listener, app).await.unwrap();
}

async fn serve_tls(listener: TcpListener, app: Router, tls: Arc<rustls::ServerConfig>) {
    let acceptor = tokio_rustls::TlsAcceptor::from(tls);
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let (acceptor, app) = (acceptor.clone(), app.clone());
        tokio::spawn(async move {
            let Ok(stream) = acceptor.accept(stream).await else {
                return;
            };
            let service = TowerToHyperService::new(app);
            let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

async fn bind() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

impl Harness {
    /// Start a server with open signups and the production hash registry.
    pub async fn start() -> Self {
        Self::start_with(|config| config).await
    }

    pub async fn start_with(configure: impl FnOnce(ServerConfig) -> ServerConfig) -> Self {
        let db = Db::connect_memory().await.unwrap();
        let (tls_listener, tls_addr) = bind().await;
        let (listener, addr) = bind().await;
        let secure = format!("https://127.0.0.1:{}{MOUNT}", tls_addr.port());
        let plain = format!("http://127.0.0.1:{}{MOUNT}", addr.port());
        let mut config = ServerConfig::new(&secure);
        config.signups = SignupPolicy::Open;
        let config = configure(config);
        let server = BitwardenServer::new(db.clone(), config, HashRegistry::default(), None);
        let trace = Trace::default();
        let (tls, ca_pem) = tls_config();
        tokio::spawn(serve_tls(
            tls_listener,
            app(server.clone(), trace.clone()),
            tls,
        ));
        tokio::spawn(serve_plain(listener, app(server.clone(), trace.clone())));
        Self {
            db,
            server,
            http_url: plain,
            https_url: secure,
            ca_pem,
            trace,
        }
    }

    pub fn unrouted(&self) -> Vec<String> {
        self.trace.unrouted.lock().unwrap().clone()
    }

    pub fn seen(&self) -> Vec<String> {
        self.trace.seen.lock().unwrap().clone()
    }
}
