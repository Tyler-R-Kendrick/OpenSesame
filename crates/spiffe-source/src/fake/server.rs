//! A scripted, in-process SPIFFE Workload API over a unix socket.
//!
//! Each `FetchX509SVID` stream first receives the current snapshot (or, like
//! SPIRE, `PERMISSION_DENIED` when no identity is issued), then every event
//! pushed afterwards: a new snapshot, a status error (the stream yields the
//! error and ends), or a close (the stream ends cleanly). `shutdown` stops the
//! server and unlinks the socket, which is what an agent restart looks like
//! to a workload.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_stream::wrappers::{ReceiverStream, UnixListenerStream};
use tonic::{Request, Response, Status};

use super::pb::spiffe_workload_api_server::{SpiffeWorkloadApi, SpiffeWorkloadApiServer};
use super::pb::{
    X509BundlesRequest, X509BundlesResponse, X509svid, X509svidRequest, X509svidResponse,
};

/// One scripted step.
#[derive(Debug, Clone)]
pub enum Script {
    /// Replace the state and push it to every open stream.
    Snapshot(X509svidResponse),
    /// Every open stream yields this error and ends.
    Error(Status),
    /// Every open stream ends cleanly.
    Close,
}

#[derive(Clone)]
struct Service {
    state: Arc<Mutex<Option<X509svidResponse>>>,
    events: broadcast::Sender<Script>,
    connections: Arc<AtomicU32>,
    open_streams: Arc<AtomicUsize>,
}

/// Handle to a running fake.
pub struct FakeWorkloadApi {
    socket_path: PathBuf,
    service: Service,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
    dir: Option<tempfile::TempDir>,
}

impl std::fmt::Debug for FakeWorkloadApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeWorkloadApi")
            .field("socket_path", &self.socket_path)
            .finish_non_exhaustive()
    }
}

impl FakeWorkloadApi {
    /// Start serving on `<tempdir>/api.sock` with no identity issued.
    ///
    /// # Panics
    /// When the tempdir or socket cannot be created, or outside a tokio
    /// runtime.
    #[must_use]
    pub fn start() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("os-spiffe-")
            .tempdir()
            .expect("tempdir");
        let mut fake = Self::start_at(dir.path());
        fake.dir = Some(dir);
        fake
    }

    /// Start serving on `<dir>/api.sock` in a directory the caller owns, so
    /// a test can stop one fake and start another at the same path (an
    /// agent restart).
    ///
    /// # Panics
    /// When the socket cannot be created, or outside a tokio runtime.
    #[must_use]
    pub fn start_at(dir: &Path) -> Self {
        let socket_path = dir.join("api.sock");
        let _ = std::fs::remove_file(&socket_path);
        let (events, _) = broadcast::channel(64);
        let service = Service {
            state: Arc::new(Mutex::new(None)),
            events,
            connections: Arc::new(AtomicU32::new(0)),
            open_streams: Arc::new(AtomicUsize::new(0)),
        };
        let listener = tokio::net::UnixListener::bind(&socket_path).expect("bind unix socket");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let svc = service.clone();
        let task = tokio::spawn(async move {
            let _ = tonic::transport::Server::builder()
                .add_service(SpiffeWorkloadApiServer::new(svc))
                .serve_with_incoming_shutdown(UnixListenerStream::new(listener), async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            socket_path,
            service,
            shutdown: Some(shutdown_tx),
            task: Some(task),
            dir: None,
        }
    }

    /// How long [`Self::shutdown`] lets tonic drain before it aborts.
    const DRAIN: std::time::Duration = std::time::Duration::from_millis(250);

    /// The unix socket path.
    #[must_use]
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// A snapshot message from SVIDs plus federated bundles.
    #[must_use]
    pub fn snapshot(svids: Vec<X509svid>, federated: &[(&str, Vec<u8>)]) -> X509svidResponse {
        X509svidResponse {
            svids,
            crl: Vec::new(),
            federated_bundles: federated
                .iter()
                .map(|(td, der)| (format!("spiffe://{td}"), der.clone()))
                .collect::<HashMap<_, _>>(),
        }
    }

    /// Replace the state and push it to every open stream.
    pub fn push_snapshot(&self, snapshot: X509svidResponse) {
        if let Ok(mut state) = self.service.state.lock() {
            *state = Some(snapshot.clone());
        }
        let _ = self.service.events.send(Script::Snapshot(snapshot));
    }

    /// Forget the issued identity: new streams get `PERMISSION_DENIED`, open
    /// streams receive an empty snapshot (no SVIDs, no bundles).
    pub fn revoke_all(&self) {
        if let Ok(mut state) = self.service.state.lock() {
            *state = None;
        }
        let _ = self
            .service
            .events
            .send(Script::Snapshot(X509svidResponse::default()));
    }

    /// Every open stream yields `status` and ends.
    pub fn push_error(&self, status: Status) {
        let _ = self.service.events.send(Script::Error(status));
    }

    /// Every open stream ends cleanly.
    pub fn close_streams(&self) {
        let _ = self.service.events.send(Script::Close);
    }

    /// Streams opened so far.
    #[must_use]
    pub fn connections(&self) -> u32 {
        self.service.connections.load(Ordering::SeqCst)
    }

    /// Streams currently open.
    #[must_use]
    pub fn open_streams(&self) -> usize {
        self.service.open_streams.load(Ordering::SeqCst)
    }

    /// Stop the server and unlink the socket — what an agent going away looks
    /// like to a workload.
    ///
    /// Open streams are ended first. tonic's graceful shutdown drains
    /// *in-flight* requests, and a `FetchX509SVID` stream is in flight for as
    /// long as the workload wants it, so a still-streaming client would
    /// otherwise keep the server task alive for ever (this deadlocked
    /// `at_spiffe_outage_socket_gone_…`). Once the streams are gone the
    /// graceful signal completes; a task still alive after [`Self::DRAIN`] is
    /// aborted, and the socket is unlinked, so the workload's reconnect finds
    /// nothing there.
    pub async fn shutdown(mut self) {
        self.close_streams();
        let _ = tokio::time::timeout(Self::DRAIN, async {
            while self.open_streams() > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await;
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(Self::DRAIN, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

impl Drop for FakeWorkloadApi {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn require_security_header<T>(request: &Request<T>) -> Result<(), Status> {
    match request.metadata().get("workload.spiffe.io") {
        Some(v) if v == "true" => Ok(()),
        _ => Err(Status::invalid_argument(
            "security header missing from request",
        )),
    }
}

type SvidStream = ReceiverStream<Result<X509svidResponse, Status>>;
type BundleStream = ReceiverStream<Result<X509BundlesResponse, Status>>;

fn bundles_of(snapshot: &X509svidResponse) -> X509BundlesResponse {
    let mut bundles: HashMap<String, Vec<u8>> = HashMap::new();
    for svid in &snapshot.svids {
        if let Some((td, _)) = svid
            .spiffe_id
            .strip_prefix("spiffe://")
            .and_then(|rest| rest.split_once('/'))
        {
            bundles.insert(format!("spiffe://{td}"), svid.bundle.clone());
        }
    }
    bundles.extend(snapshot.federated_bundles.clone());
    X509BundlesResponse {
        crl: snapshot.crl.clone(),
        bundles,
    }
}

#[tonic::async_trait]
impl SpiffeWorkloadApi for Service {
    type FetchX509SVIDStream = SvidStream;
    type FetchX509BundlesStream = BundleStream;

    async fn fetch_x509svid(
        &self,
        request: Request<X509svidRequest>,
    ) -> Result<Response<Self::FetchX509SVIDStream>, Status> {
        require_security_header(&request)?;
        let initial = self.state.lock().ok().and_then(|s| s.clone());
        let Some(initial) = initial else {
            return Err(Status::permission_denied("no identity issued"));
        };
        self.connections.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(16);
        let mut events = self.events.subscribe();
        let open = Arc::clone(&self.open_streams);
        open.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            if tx.send(Ok(initial)).await.is_err() {
                open.fetch_sub(1, Ordering::SeqCst);
                return;
            }
            loop {
                let outcome = match events.recv().await {
                    Ok(Script::Snapshot(s)) => tx.send(Ok(s)).await.is_ok(),
                    Ok(Script::Error(status)) => {
                        let _ = tx.send(Err(status)).await;
                        false
                    }
                    Ok(Script::Close) | Err(broadcast::error::RecvError::Closed) => false,
                    Err(broadcast::error::RecvError::Lagged(_)) => true,
                };
                if !outcome {
                    break;
                }
            }
            open.fetch_sub(1, Ordering::SeqCst);
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn fetch_x509_bundles(
        &self,
        request: Request<X509BundlesRequest>,
    ) -> Result<Response<Self::FetchX509BundlesStream>, Status> {
        require_security_header(&request)?;
        let initial = self.state.lock().ok().and_then(|s| s.clone());
        let Some(initial) = initial else {
            return Err(Status::permission_denied("no identity issued"));
        };
        let (tx, rx) = mpsc::channel(16);
        let mut events = self.events.subscribe();
        tokio::spawn(async move {
            if tx.send(Ok(bundles_of(&initial))).await.is_err() {
                return;
            }
            loop {
                let outcome = match events.recv().await {
                    Ok(Script::Snapshot(s)) => tx.send(Ok(bundles_of(&s))).await.is_ok(),
                    Ok(Script::Error(status)) => {
                        let _ = tx.send(Err(status)).await;
                        false
                    }
                    Ok(Script::Close) | Err(broadcast::error::RecvError::Closed) => false,
                    Err(broadcast::error::RecvError::Lagged(_)) => true,
                };
                if !outcome {
                    break;
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}
