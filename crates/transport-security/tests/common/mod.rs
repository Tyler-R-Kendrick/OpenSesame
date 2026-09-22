//! Shared harness: a router that reports what the listener stamped on the
//! request, a served listener with counters, raw tokio-rustls HTTP/1.1
//! clients (so a test controls the exact bytes and the exact connection),
//! and the `openssl s_client` oracle.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use opensesame_domain::transport::{
    PeerEvidenceView, TransportError, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    enforce_current_generation, Generation, GenerationCandidate, ListenerCounters, ListenerLimits,
    ListenerProvenance, PeerExtension, SecureListener, ServerProfile, TransportGenerations,
    TrustBundle,
};
use rustls::pki_types::ServerName;
use rustls::ClientConfig;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

/// The `openssl s_client` oracle lives in its own module: it is only used by
/// `tests/openssl_oracle.rs`, which imports it directly.
pub mod openssl;

pub const CLIENTS: &str = "clients";
pub const LISTENER: &str = "test-tls";

pub fn profile_ref(name: &str) -> TrustProfileRef {
    TrustProfileRef::new(name).expect("profile ref")
}

pub fn private_root(name: &str, ca: &DisposableCa) -> TrustBundle {
    TrustBundle::from_pem(
        profile_ref(name),
        TrustProfileKind::PrivateRoot,
        &ca.root_pem(),
    )
    .expect("bundle")
}

pub fn spiffe_bundle(name: &str, ca: &DisposableCa) -> TrustBundle {
    TrustBundle::from_pem(
        profile_ref(name),
        TrustProfileKind::SpiffeTrustDomain,
        &ca.root_pem(),
    )
    .expect("bundle")
}

/// Generations whose identity is `server` and whose only peer bundle is
/// `CLIENTS` → the root of `client_ca`.
pub fn generations(
    server: opensesame_transport_security::TlsIdentity,
    client_ca: &DisposableCa,
) -> Arc<TransportGenerations> {
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(server)),
        peer_trust: [(profile_ref(CLIENTS), private_root(CLIENTS, client_ca))].into(),
        own_trust: None,
        identity_required: true,
    };
    TransportGenerations::new(
        candidate
            .into_generation(1, chrono::Utc::now())
            .expect("initial"),
    )
}

/// A profile function for `policy` with the default limits.
pub fn profile_fn(
    policy: TransportPolicy,
) -> impl Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync + 'static {
    profile_fn_with(policy, ListenerLimits::default())
}

pub fn profile_fn_with(
    policy: TransportPolicy,
    limits: ListenerLimits,
) -> impl Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync + 'static {
    move |generation: &Generation| {
        let identity = generation
            .identity
            .clone()
            .ok_or(TransportError::IdentityMissing)?;
        let mut profile = ServerProfile::new(policy, identity, LISTENER);
        profile.limits = limits;
        if policy.authenticates_client() {
            profile.client_trust = Some(generation.trust(&profile_ref(CLIENTS))?.clone());
        }
        Ok(profile)
    }
}

#[derive(Clone, Default)]
pub struct Hits {
    pub protected: Arc<AtomicU64>,
    /// Bumped as `/slow` *enters*, so a test can wait for a request to be
    /// genuinely in flight instead of guessing with a sleep.
    pub entered_slow: Arc<AtomicU64>,
}

impl Hits {
    pub fn protected(&self) -> u64 {
        self.protected.load(Ordering::SeqCst)
    }
    /// Wait until `/slow` has been entered `at_least` times, or give up
    /// after `within`.
    pub async fn await_slow(&self, at_least: u64, within: Duration) -> bool {
        tokio::time::timeout(within, async {
            while self.entered_slow.load(Ordering::SeqCst) < at_least {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .is_ok()
    }
}

async fn whoami(req: Request) -> axum::response::Response {
    let provenance = req.extensions().get::<ListenerProvenance>().cloned();
    let peer: Option<PeerEvidenceView> =
        req.extensions().get::<PeerExtension>().map(|p| p.0.view());
    let (listener, policy, generation) = match provenance {
        Some(ListenerProvenance::Tls {
            listener_id,
            policy,
            generation,
        }) => (listener_id, format!("{policy:?}"), generation),
        Some(ListenerProvenance::Plain { listener_id }) => (listener_id, "Plain".into(), 0),
        None => ("<none>".into(), "<none>".into(), 0),
    };
    axum::Json(serde_json::json!({
        "listener": listener, "policy": policy, "generation": generation, "peer": peer,
    }))
    .into_response()
}

async fn protected(State(hits): State<Hits>) -> &'static str {
    hits.protected.fetch_add(1, Ordering::SeqCst);
    "protected ok"
}

async fn slow(State(hits): State<Hits>) -> &'static str {
    hits.entered_slow.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(400)).await;
    "slow ok"
}

async fn echo_len(body: axum::body::Bytes) -> String {
    body.len().to_string()
}

/// `/health`, `/whoami`, `/slow`, `/echo` (POST, returns body length) and
/// `/protected` (guarded by `enforce_current_generation`, counts hits).
pub fn router(generations: Arc<TransportGenerations>, hits: Hits) -> Router {
    let guarded = Router::new()
        .route("/protected", get(protected))
        .layer(axum::middleware::from_fn_with_state(
            generations,
            enforce_current_generation,
        ))
        .with_state(hits.clone());
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/whoami", get(whoami))
        .route("/echo", post(echo_len))
        .merge(Router::new().route("/slow", get(slow)).with_state(hits))
        .merge(guarded)
}

pub struct Served {
    pub addr: SocketAddr,
    pub counters: Arc<ListenerCounters>,
    task: Option<tokio::task::JoinHandle<Result<(), TransportError>>>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Served {
    /// Stop accepting and wait for the serve loop to drain.
    pub async fn shutdown(mut self) -> Result<(), TransportError> {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let task = self.task.take().expect("serve task");
        task.await.expect("serve task")
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

pub async fn serve(
    generations: Arc<TransportGenerations>,
    profile: impl Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync + 'static,
    app: Router,
) -> Served {
    let listener = SecureListener::bind("127.0.0.1:0".parse().unwrap(), generations, profile)
        .await
        .expect("bind");
    let addr = listener.local_addr();
    let counters = listener.counters();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(listener.serve_until(app, async move {
        let _ = rx.await;
    }));
    Served {
        addr,
        counters,
        task: Some(task),
        shutdown: Some(tx),
    }
}

pub async fn connect(
    config: Arc<ClientConfig>,
    addr: SocketAddr,
    server_name: ServerName<'static>,
) -> Result<TlsStream<TcpStream>, String> {
    let tcp = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("tcp: {e}"))?;
    TlsConnector::from(config)
        .connect(server_name, tcp)
        .await
        .map_err(|e| format!("tls: {e}"))
}

/// One HTTP/1.1 request on an open stream (keep-alive), returning status
/// and body. Reads exactly `Content-Length` bytes so the stream stays
/// usable for the next request.
pub async fn request_on(
    stream: &mut TlsStream<TcpStream>,
    path: &str,
) -> Result<(u16, String), String> {
    let req = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err(format!(
                "eof before headers: {}",
                String::from_utf8_lossy(&buf)
            ));
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("no status in {head}"))?;
    let length: usize = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse().unwrap_or(0))
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|e| format!("body: {e}"))?;
    Ok((status, String::from_utf8_lossy(&body).to_string()))
}

/// Connect, send one request, close.
pub async fn raw_get(
    config: Arc<ClientConfig>,
    addr: SocketAddr,
    server_name: ServerName<'static>,
    path: &str,
) -> Result<(u16, String), String> {
    let mut stream = connect(config, addr, server_name).await?;
    let result = request_on(&mut stream, path).await;
    let _ = stream.shutdown().await;
    result
}

pub fn localhost() -> ServerName<'static> {
    ServerName::try_from("localhost").expect("server name")
}
