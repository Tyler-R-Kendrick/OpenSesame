//! One run's listener: an HTTP/1.1 forward proxy on 127.0.0.1.
//!
//! Every request to it must carry the run's proxy credential, or it gets a
//! `407` and nothing else. A `CONNECT` is answered `200` and its tunnel is
//! handed to [`crate::tunnel`], which terminates TLS and scans each request
//! inside. A plain-HTTP request in absolute form is scanned so a surrogate in
//! it trips `surrogate.cleartext`, and then refused whatever it carried:
//! there is no plaintext egress. Anything else is refused.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use opensesame_invoke_through::Refusal;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::auth::ProxyCredential;
use crate::ca::RunCa;
use crate::config::Shared;
use crate::respond::{self, ProxyBody};
use crate::target::Target;
use crate::{broker, tunnel};

/// How long a client may take to send a request head.
pub(crate) const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// The pause after a failed accept.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);
const HTTPS_PORT: u16 = 443;

/// What one run's listener and tunnels know.
pub(crate) struct RunContext {
    /// The identity admission compares a surrogate's issued caller against:
    /// this run instance, and nothing a client can choose.
    pub(crate) caller: String,
    pub(crate) credential: ProxyCredential,
    pub(crate) ca: RunCa,
    pub(crate) passthrough_hosts: Vec<String>,
    pub(crate) shared: Arc<Shared>,
    pub(crate) shutdown: watch::Receiver<bool>,
}

impl std::fmt::Debug for RunContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunContext")
            .field("passthrough_hosts", &self.passthrough_hosts)
            .finish_non_exhaustive()
    }
}

impl RunContext {
    /// Hand a refusal to the embedder's sink: the tripwire.
    pub(crate) fn report(&self, refusal: &Refusal) {
        self.shared.config.refusals.refused(refusal);
    }

    /// A passthrough host is named exactly, and served on 443 only.
    pub(crate) fn is_passthrough(&self, target: &Target) -> bool {
        target.port == HTTPS_PORT && self.passthrough_hosts.contains(&target.host)
    }

    /// Resolves when the run ends (or its registry is dropped).
    pub(crate) async fn ended(&self) {
        let mut shutdown = self.shutdown.clone();
        // An error means the sender is gone: the run is over either way.
        let _ = shutdown.changed().await;
    }
}

/// Accept connections until the run ends.
pub(crate) async fn serve(listener: TcpListener, ctx: Arc<RunContext>) {
    loop {
        tokio::select! {
            () = ctx.ended() => break,
            accepted = listener.accept() => dispatch(accepted, &ctx).await,
        }
    }
}

async fn dispatch(accepted: std::io::Result<(TcpStream, SocketAddr)>, ctx: &Arc<RunContext>) {
    match accepted {
        Ok((stream, _)) => {
            tokio::spawn(connection(stream, Arc::clone(ctx)));
        }
        // Out of descriptors, or a connection reset before accept: back off
        // rather than spin, and keep serving.
        Err(_) => tokio::time::sleep(ACCEPT_BACKOFF).await,
    }
}

async fn connection(stream: TcpStream, ctx: Arc<RunContext>) {
    let service_ctx = Arc::clone(&ctx);
    let service = service_fn(move |req| outer(Arc::clone(&service_ctx), req));
    let conn = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades();
    tokio::select! {
        _ = conn => {}
        () = ctx.ended() => {}
    }
}

async fn outer(
    ctx: Arc<RunContext>,
    mut req: Request<Incoming>,
) -> Result<Response<ProxyBody>, Infallible> {
    let authorization = req.headers().get(hyper::header::PROXY_AUTHORIZATION);
    if !ctx.credential.admits(authorization) {
        return Ok(respond::proxy_auth_required());
    }
    if req.method() == Method::CONNECT {
        let Some(target) = Target::parse_connect(req.uri()) else {
            return Ok(respond::refused(StatusCode::BAD_REQUEST));
        };
        let upgrade = hyper::upgrade::on(&mut req);
        tokio::spawn(tunnel::run(ctx, upgrade, target));
        return Ok(respond::tunnel_established());
    }
    Ok(broker::handle_plain(&ctx, req).await)
}

/// Poison is not a reason to stop refusing: a panicked holder cannot have
/// left the ledger half-written, since every write is one map operation.
pub(crate) fn unpoison<T>(result: Result<T, PoisonError<T>>) -> T {
    result.unwrap_or_else(PoisonError::into_inner)
}
