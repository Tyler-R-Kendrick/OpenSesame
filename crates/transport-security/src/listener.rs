//! [`SecureListener`]: a TLS listener that serves an axum router and stamps
//! every request with its provenance and, on authenticating profiles, the
//! verified peer.
//!
//! The listener follows [`TransportGenerations`]: each accepted connection
//! is handshaken with the acceptor prepared for the *current* generation,
//! rebuilt lazily when the number changes, and refused outright when the
//! current generation is withdrawn. Bounds: concurrent handshakes
//! (semaphore, acquired before the handshake starts), handshake timeout,
//! idle timeout, HTTP/1 buffer and HTTP/2 header-list size, and a body
//! limit layered outermost on the router (a caller's own
//! `DefaultBodyLimit` on the router or a route wins, because inner layers
//! overwrite the extension).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::extract::DefaultBodyLimit;
use axum::Router;
use opensesame_domain::transport::TransportError;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio_rustls::TlsAcceptor;

use crate::error::malformed;
use crate::generations::{Generation, TransportGenerations};
use crate::server::{server_config, ServerProfile};
use crate::server_conn::{serve_connection, Prepared};

type ProfileFn = dyn Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync;

/// Observable outcomes, for tests and status views.
#[derive(Debug, Default)]
pub struct ListenerCounters {
    handshakes_ok: AtomicU64,
    handshakes_failed: AtomicU64,
    refused_withdrawn: AtomicU64,
    refused_unprepared: AtomicU64,
    resumed: AtomicU64,
}

impl ListenerCounters {
    #[must_use]
    pub fn handshakes_ok(&self) -> u64 {
        self.handshakes_ok.load(Ordering::SeqCst)
    }
    #[must_use]
    pub fn handshakes_failed(&self) -> u64 {
        self.handshakes_failed.load(Ordering::SeqCst)
    }
    /// Connections closed before a handshake because the generation was
    /// withdrawn.
    #[must_use]
    pub fn refused_withdrawn(&self) -> u64 {
        self.refused_withdrawn.load(Ordering::SeqCst)
    }
    /// Connections closed because the current generation produced no
    /// usable server profile.
    #[must_use]
    pub fn refused_unprepared(&self) -> u64 {
        self.refused_unprepared.load(Ordering::SeqCst)
    }
    /// Handshakes rustls reported as resumed. Always zero on authenticating
    /// profiles.
    #[must_use]
    pub fn resumed(&self) -> u64 {
        self.resumed.load(Ordering::SeqCst)
    }
    pub(crate) fn record_ok(&self) {
        self.handshakes_ok.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) fn record_failed(&self) {
        self.handshakes_failed.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) fn record_resumed(&self) {
        self.resumed.fetch_add(1, Ordering::SeqCst);
    }
}

/// A bound TLS listener that has not started serving yet.
pub struct SecureListener {
    tcp: TcpListener,
    local_addr: SocketAddr,
    generations: Arc<TransportGenerations>,
    profile_fn: Arc<ProfileFn>,
    prepared: ArcSwap<Prepared>,
    counters: Arc<ListenerCounters>,
}

impl std::fmt::Debug for SecureListener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecureListener")
            .field("local_addr", &self.local_addr)
            .field("generation", &self.prepared.load().number)
            .finish_non_exhaustive()
    }
}

fn prepare(profile_fn: &ProfileFn, generation: &Generation) -> Result<Prepared, TransportError> {
    if let Some(reason) = &generation.withdrawn {
        return Err(reason.clone());
    }
    let profile = profile_fn(generation)?;
    let config = server_config(&profile)?;
    Ok(Prepared {
        number: generation.number,
        acceptor: TlsAcceptor::from(config),
        profile: Arc::new(profile),
    })
}

impl SecureListener {
    /// Bind `addr` and prepare the acceptor for the current generation. A
    /// generation that cannot produce a valid server configuration is an
    /// error here, before anything listens: a required profile with bad
    /// material never serves.
    ///
    /// # Errors
    ///
    /// The profile's or configuration's error, or
    /// `MalformedConfiguration` when the socket cannot be bound.
    pub async fn bind(
        addr: SocketAddr,
        generations: Arc<TransportGenerations>,
        profile_fn: impl Fn(&Generation) -> Result<ServerProfile, TransportError>
            + Send
            + Sync
            + 'static,
    ) -> Result<Self, TransportError> {
        let profile_fn: Arc<ProfileFn> = Arc::new(profile_fn);
        let prepared = prepare(profile_fn.as_ref(), &generations.current())?;
        let tcp = TcpListener::bind(addr)
            .await
            .map_err(|e| malformed(format!("bind {addr}: {e}")))?;
        let local_addr = tcp
            .local_addr()
            .map_err(|e| malformed(format!("local_addr: {e}")))?;
        Ok(Self {
            tcp,
            local_addr,
            generations,
            profile_fn,
            prepared: ArcSwap::from_pointee(prepared),
            counters: Arc::new(ListenerCounters::default()),
        })
    }

    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Counters shared with the serving loop.
    #[must_use]
    pub fn counters(&self) -> Arc<ListenerCounters> {
        Arc::clone(&self.counters)
    }

    /// The acceptor for the current generation, rebuilt when it changed.
    /// Count a refused accept under the reason it was refused and say so.
    fn note_refusal(&self, reason: &TransportError) {
        let counter = if self.generations.current().withdrawn.is_some() {
            &self.counters.refused_withdrawn
        } else {
            &self.counters.refused_unprepared
        };
        counter.fetch_add(1, Ordering::SeqCst);
        tracing::warn!(code = reason.code(), "secure listener refused connection");
    }

    fn current_prepared(&self) -> Result<Arc<Prepared>, TransportError> {
        let generation = self.generations.current();
        if let Some(reason) = &generation.withdrawn {
            return Err(reason.clone());
        }
        let prepared = self.prepared.load_full();
        if prepared.number == generation.number {
            return Ok(prepared);
        }
        let rebuilt = Arc::new(prepare(self.profile_fn.as_ref(), &generation)?);
        self.prepared.store(Arc::clone(&rebuilt));
        tracing::info!(
            generation = generation.number,
            "secure listener switched generation"
        );
        Ok(rebuilt)
    }

    /// Serve `app` until the socket fails.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when accepting fails permanently.
    pub async fn serve(self, app: Router) -> Result<(), TransportError> {
        self.serve_until(app, std::future::pending::<()>()).await
    }

    /// Serve `app` until `shutdown` resolves, then stop accepting and let
    /// in-flight connections finish gracefully.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when accepting fails permanently.
    pub async fn serve_until(
        self,
        app: Router,
        shutdown: impl std::future::Future<Output = ()> + Send,
    ) -> Result<(), TransportError> {
        let limits = self.prepared.load().profile.limits;
        let app = app.layer(DefaultBodyLimit::max(limits.max_body_bytes));
        let handshakes = Arc::new(Semaphore::new(limits.max_concurrent_handshakes));
        let graceful = hyper_util::server::graceful::GracefulShutdown::new();
        tokio::pin!(shutdown);
        loop {
            let permit = tokio::select! {
                () = &mut shutdown => break,
                permit = Arc::clone(&handshakes).acquire_owned() => match permit {
                    Ok(permit) => permit,
                    Err(_) => break,
                },
            };
            let (stream, _) = tokio::select! {
                () = &mut shutdown => break,
                accepted = self.tcp.accept() => accepted.map_err(|e| malformed(format!("accept: {e}")))?,
            };
            let prepared = match self.current_prepared() {
                Ok(prepared) => prepared,
                Err(reason) => {
                    self.note_refusal(&reason);
                    drop(stream);
                    continue;
                }
            };
            tokio::spawn(serve_connection(
                prepared,
                Arc::clone(&self.generations),
                stream,
                app.clone(),
                Arc::clone(&self.counters),
                Some(graceful.watcher()),
                permit,
            ));
        }
        graceful.shutdown().await;
        Ok(())
    }
}
